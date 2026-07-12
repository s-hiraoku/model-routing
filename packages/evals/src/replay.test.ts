import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  insertEvalTask,
  insertTaskEvent,
  listReplayRunsForTask,
  upsertSession,
} from "@model-routing/datastore";
import type { EvalConfig, ModelsConfig } from "@model-routing/shared";
import { replayAgentPermissions, replayVariants, runReplayStage, startReplayGateway, variantModel } from "./replay";

const config: EvalConfig = {
  sampling: {
    per_batch: 20,
    per_category_min: 3,
    self_contained_only: true,
    max_task_prompt_chars: 8000,
    dedup_window_days: 30,
    exclude_repos: [],
  },
  replay: {
    variants: [{ id: "high" }, { id: "mid" }, { id: "low" }, { id: "mid+demote" }],
    baseline: "mid",
    isolation: "worktree",
    timeout_minutes: 15,
    concurrency: 1,
    verify_commands: {},
    setup_commands: {},
  },
  judge: { primary: "high", position_swap: true },
  human_review: { sample_rate: 0.25, low_margin_always: true },
  schedule: { allowed_hours: [], pause_on_rate_limit: true },
  policy_generation: {
    demote_min_n: 10,
    demote_wilson_low: 0.4,
    promote_min_n: 10,
    promote_wilson_low: 0.55,
    min_kappa: 0.6,
  },
};

const models: ModelsConfig = {
  tiers: {
    high: { model: "claude-opus-4-8", match: ["claude-opus-*"], strip_params: [] },
    mid: { model: "claude-fable-5", match: ["claude-fable-*"], strip_params: [] },
    low: { model: "claude-haiku-4-5-20251001", match: ["claude-haiku-*"], strip_params: ["output_config.effort"] },
  },
  never_touch: ["claude-haiku-*"],
  subscription: { window_hours: 5, eval_runs_per_window: 20 },
};

async function seedEvalTask(dbPath: string): Promise<void> {
  upsertSession(dbPath, { id: "session-1", cwd: "/repo", gitRemote: null, seenAt: 1 });
  insertTaskEvent(dbPath, {
    id: "0197d239-7c00-7000-8000-000000000001",
    sessionId: "session-1",
    createdAt: 1,
    cwd: "/repo",
    gitHead: "abc",
    gitDirty: false,
    promptText: "README",
    promptHash: "hash",
    taskCategory: "docs",
    categorySource: "heuristic",
    categoryConfidence: 0.8,
    selfContained: true,
  });
  insertEvalTask(dbPath, {
    id: "0197d239-7c00-7000-8000-000000000101",
    taskEventId: "0197d239-7c00-7000-8000-000000000001",
    batchId: "2026-W28",
    createdAt: 2,
    taskCategory: "docs",
    repoPath: "/repo",
    baseCommit: "abc",
    promptText: "README",
    verifyCommand: null,
  });
}

describe("replayVariants", () => {
  test("maps variants to configured tier models", () => {
    expect(variantModel("high", models)).toBe("claude-opus-4-8");
    expect(variantModel("low", models)).toBe("claude-haiku-4-5-20251001");
    expect(variantModel("mid+demote", models)).toBe("claude-fable-5");
    expect(replayVariants(config, models)).toHaveLength(4);
  });
});

describe("replayAgentPermissions", () => {
  test("auto-approves only worktree coding tools inside a mandatory sandbox", () => {
    expect(replayAgentPermissions()).toEqual({
      permissionMode: "acceptEdits",
      tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
      },
    });
  });
});

describe("startReplayGateway", () => {
  test("binds each replay run to a separate ephemeral port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-replay-gateway-"));
    const first = startReplayGateway({
      runId: "run-1",
      variantId: "mid",
      upstreamBaseUrl: "https://upstream.invalid",
      dataDir: dir,
      dbPath: join(dir, "model-routing.db"),
      models,
    });
    const second = startReplayGateway({
      runId: "run-2",
      variantId: "mid+demote",
      upstreamBaseUrl: "https://upstream.invalid",
      dataDir: dir,
      dbPath: join(dir, "model-routing.db"),
      models,
    });

    try {
      expect(first.port).not.toBe(second.port);
      expect((await fetch(new URL("/internal/healthz", first.url))).status).toBe(200);
    } finally {
      first.stop(true);
      second.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runReplayStage", () => {
  test("inserts one replay run per variant and skips existing runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-replay-stage-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      await seedEvalTask(dbPath);

      const first = await runReplayStage({
        dbPath,
        batchId: "2026-W28",
        config,
        models,
        dataDir: dir,
        executor: async () => ({
          status: "ok",
          durationMs: 1,
          turns: 1,
          totalInputTokens: 10,
          totalOutputTokens: 2,
          totalCacheRead: 0,
          diffPath: null,
          diffStat: null,
          finalMessagePath: null,
          verifyPassed: null,
          errorMessage: null,
        }),
      });
      const second = await runReplayStage({
        dbPath,
        batchId: "2026-W28",
        config,
        models,
        dataDir: dir,
        executor: async () => {
          throw new Error("should not run");
        },
      });

      expect(first).toEqual({ tasks: 1, insertedRuns: 4, skippedRuns: 0 });
      expect(second).toEqual({ tasks: 1, insertedRuns: 0, skippedRuns: 4 });
      expect(listReplayRunsForTask(dbPath, "0197d239-7c00-7000-8000-000000000101")).toHaveLength(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
