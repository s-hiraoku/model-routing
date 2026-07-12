import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EvalTaskRow,
  insertQuotaEvent,
  insertReplayRun,
  listEvalTasksByBatch,
  listReplayRunsForTask,
  type ReplayRunInsert,
} from "@model-routing/datastore";
import { createGatewayApp, createReplayVariantPolicies } from "@model-routing/gateway";
import { type EvalConfig, type ModelsConfig, uuidv7 } from "@model-routing/shared";
import { addWorktree, collectPatch, removeWorktree, runCommand, writeRunArtifact } from "./worktree";

export type ReplayVariant = {
  id: string;
  model: string;
};

export type ReplayExecutionResult = Omit<ReplayRunInsert, "id" | "evalTaskId" | "variant" | "createdAt">;

export type ReplayExecutor = (args: {
  runId: string;
  task: EvalTaskRow;
  variant: ReplayVariant;
  config: EvalConfig;
  models: ModelsConfig;
  dataDir: string;
  dbPath: string;
  upstreamBaseUrl: string;
}) => Promise<ReplayExecutionResult>;

const REPLAY_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

export function replayAgentPermissions() {
  return {
    permissionMode: "acceptEdits" as const,
    tools: REPLAY_TOOLS,
    allowedTools: REPLAY_TOOLS,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
    },
  };
}

export function variantModel(variantId: string, models: ModelsConfig): string {
  if (variantId === "high") {
    return models.tiers.high.model;
  }

  if (variantId === "low") {
    return models.tiers.low.model;
  }

  return models.tiers.mid.model;
}

export function replayVariants(config: EvalConfig, models: ModelsConfig): ReplayVariant[] {
  return config.replay.variants.map((variant) => ({
    id: variant.id,
    model: variantModel(variant.id, models),
  }));
}

export function startReplayGateway(args: {
  runId: string;
  variantId: string;
  upstreamBaseUrl: string;
  dataDir: string;
  dbPath: string;
  models: ModelsConfig;
}) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createGatewayApp({
      upstream: args.upstreamBaseUrl,
      mode: "passthrough",
      dataDir: args.dataDir,
      dbPath: args.dbPath,
      models: args.models,
      variantPolicies: createReplayVariantPolicies(),
      replayContext: { runId: args.runId, variant: args.variantId },
    }).fetch,
  });
}

export async function defaultReplayExecutor(args: {
  runId: string;
  task: EvalTaskRow;
  variant: ReplayVariant;
  config: EvalConfig;
  models: ModelsConfig;
  dataDir: string;
  dbPath: string;
  upstreamBaseUrl: string;
}): Promise<ReplayExecutionResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const worktreeRoot = await mkdtemp(join(tmpdir(), "model-routing-replay-"));
  const worktreePath = join(worktreeRoot, `wt-${args.runId}`);
  const runDir = join(args.dataDir, "runs", args.runId);
  const startedAt = Date.now();
  const transcript: unknown[] = [];
  let finalMessage = "";
  let replayGateway: ReturnType<typeof Bun.serve> | null = null;

  try {
    await addWorktree({
      repoPath: args.task.repoPath,
      worktreePath,
      baseCommit: args.task.baseCommit,
    });

    const setupCommand = args.config.replay.setup_commands[args.task.repoPath];
    if (setupCommand) {
      const setup = await runCommand(["bash", "-lc", setupCommand], worktreePath);
      if (setup.exitCode !== 0) {
        throw new Error(`setup command failed: ${setup.stderr || setup.stdout}`);
      }
    }

    replayGateway = startReplayGateway({
      runId: args.runId,
      variantId: args.variant.id,
      upstreamBaseUrl: args.upstreamBaseUrl,
      dataDir: args.dataDir,
      dbPath: args.dbPath,
      models: args.models,
    });

    for await (const message of query({
      prompt: args.task.promptText,
      options: {
        model: args.variant.model,
        cwd: worktreePath,
        ...replayAgentPermissions(),
        env: {
          ...Bun.env,
          ANTHROPIC_BASE_URL: replayGateway.url.toString(),
          MODEL_ROUTING_REPLAY_RUN_ID: args.runId,
          MODEL_ROUTING_VARIANT: args.variant.id,
          CLAUDE_AGENT_SDK_CLIENT_APP: "model-routing-evals-replay",
        },
      },
    })) {
      transcript.push(message);
      const maybeResult = message as { type?: string; result?: unknown };
      if (maybeResult.type === "result" && typeof maybeResult.result === "string") {
        finalMessage = maybeResult.result;
      }
    }

    const verifyCommand = args.task.verifyCommand ?? args.config.replay.verify_commands[args.task.repoPath];
    let verifyPassed: boolean | null = null;
    if (verifyCommand) {
      verifyPassed = (await runCommand(["bash", "-lc", verifyCommand], worktreePath)).exitCode === 0;
    }

    const patch = await collectPatch(worktreePath);
    const diffPath = await writeRunArtifact(runDir, "changes.patch", patch.patch);
    const finalMessagePath = await writeRunArtifact(runDir, "final.md", finalMessage);
    await writeRunArtifact(runDir, "transcript.json", JSON.stringify(transcript, null, 2));

    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      turns: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCacheRead: null,
      diffPath,
      diffStat: patch.diffStat,
      finalMessagePath,
      verifyPassed,
      errorMessage: null,
    };
  } catch (error) {
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      turns: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCacheRead: null,
      diffPath: null,
      diffStat: null,
      finalMessagePath: null,
      verifyPassed: null,
      errorMessage: error instanceof Error ? error.message : "unknown replay error",
    };
  } finally {
    replayGateway?.stop(true);
    await removeWorktree(args.task.repoPath, worktreePath);
  }
}

export async function runReplayStage(args: {
  dbPath: string;
  batchId: string;
  config: EvalConfig;
  models: ModelsConfig;
  dataDir: string;
  upstreamBaseUrl?: string;
  executor?: ReplayExecutor;
}): Promise<{ tasks: number; insertedRuns: number; skippedRuns: number }> {
  const tasks = listEvalTasksByBatch(args.dbPath, args.batchId);
  const variants = replayVariants(args.config, args.models);
  const executor = args.executor ?? defaultReplayExecutor;
  let insertedRuns = 0;
  let skippedRuns = 0;

  for (const task of tasks) {
    const existing = new Set(listReplayRunsForTask(args.dbPath, task.id).map((run) => run.variant));

    for (const variant of variants) {
      if (existing.has(variant.id)) {
        skippedRuns += 1;
        continue;
      }

      const runId = uuidv7();
      const result = await executor({
        runId,
        task,
        variant,
        config: args.config,
        models: args.models,
        dataDir: args.dataDir,
        dbPath: args.dbPath,
        upstreamBaseUrl: args.upstreamBaseUrl ?? "https://api.anthropic.com",
      });

      insertReplayRun(args.dbPath, {
        id: runId,
        evalTaskId: task.id,
        variant: variant.id,
        createdAt: Date.now(),
        ...result,
      });
      insertQuotaEvent(args.dbPath, { id: uuidv7(), createdAt: Date.now(), kind: "replay_run", refId: runId });
      insertedRuns += 1;
    }
  }

  return { tasks: tasks.length, insertedRuns, skippedRuns };
}
