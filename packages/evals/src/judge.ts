import { readFile } from "node:fs/promises";
import {
  type EvalTaskRow,
  insertJudgment,
  type JudgmentRow,
  listEvalTasksByBatch,
  listJudgmentsForTask,
  listReplayRunsForTask,
  type ReplayRunRow,
} from "@model-routing/datastore";
import { type EvalConfig, type ModelsConfig, uuidv7 } from "@model-routing/shared";
import { runCommand } from "./worktree";

export const pairwisePromptVersion = "pairwise-v1";

export type JudgePosition = "candidate_first" | "baseline_first";
export type NormalizedJudgeVerdict = "candidate_win" | "baseline_win" | "tie";

export type PairwiseJudgeResult = {
  verdict: NormalizedJudgeVerdict;
  scores: unknown;
  rationale: string;
};

export type JudgeExecutor = (args: {
  task: EvalTaskRow;
  candidate: ReplayRunRow;
  baseline: ReplayRunRow;
  position: JudgePosition;
  promptTemplate: string;
  model: string;
  gatewayBaseUrl?: string;
}) => Promise<PairwiseJudgeResult>;

type JudgeJson = {
  verdict: "A" | "B" | "tie";
  scores: unknown;
  rationale: string;
};

const scoreSchema = {
  type: "object",
  properties: {
    correctness: { type: "number", minimum: 1, maximum: 5 },
    instruction_following: { type: "number", minimum: 1, maximum: 5 },
    code_quality: { type: "number", minimum: 1, maximum: 5 },
    efficiency: { type: "number", minimum: 1, maximum: 5 },
  },
  required: ["correctness", "instruction_following", "code_quality", "efficiency"],
  additionalProperties: false,
};

const judgeOutputSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["A", "B", "tie"] },
    scores: {
      type: "object",
      properties: {
        A: scoreSchema,
        B: scoreSchema,
      },
      required: ["A", "B"],
      additionalProperties: false,
    },
    rationale: { type: "string" },
  },
  required: ["verdict", "scores", "rationale"],
  additionalProperties: false,
};

export function judgeModel(config: EvalConfig, models: ModelsConfig): string {
  if (config.judge.primary === "high" || config.judge.primary === "mid" || config.judge.primary === "low") {
    return models.tiers[config.judge.primary].model;
  }

  return config.judge.primary;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

async function readArtifact(path: string | null, fallback: string): Promise<string> {
  if (!path) {
    return fallback;
  }

  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

function extractChangedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line);
    if (match?.[1] && match[1] !== "/dev/null") {
      files.add(match[1]);
    }
  }

  return [...files].slice(0, 20);
}

async function beforeContext(task: EvalTaskRow, patchA: string, patchB: string): Promise<string> {
  const chunks: string[] = [];
  let remainingChars = 30_000;

  for (const file of extractChangedFiles(`${patchA}\n${patchB}`)) {
    if (remainingChars <= 0) {
      break;
    }

    const result = await runCommand(["git", "show", `${task.baseCommit}:${file}`], task.repoPath);
    const contents =
      result.exitCode === 0 ? result.stdout : `[${file} was not present at ${task.baseCommit} or could not be read]`;
    const section = `## ${file}\n${truncate(contents, remainingChars)}`;
    chunks.push(section);
    remainingChars -= section.length;
  }

  return chunks.length > 0 ? chunks.join("\n\n") : "[no changed files]";
}

function verifyLabel(run: ReplayRunRow): string {
  if (run.verifyPassed == null) {
    return "not_run";
  }

  return run.verifyPassed ? "passed" : "failed";
}

function replaceAllLiteral(value: string, replacements: Record<string, string>): string {
  let result = value;
  for (const [key, replacement] of Object.entries(replacements)) {
    result = result.split(`{${key}}`).join(replacement);
  }

  return result;
}

export async function renderPairwisePrompt(args: {
  task: EvalTaskRow;
  candidate: ReplayRunRow;
  baseline: ReplayRunRow;
  position: JudgePosition;
  promptTemplate: string;
}): Promise<string> {
  const candidateDiff = truncate(await readArtifact(args.candidate.diffPath, "[no diff artifact]"), 60_000);
  const baselineDiff = truncate(await readArtifact(args.baseline.diffPath, "[no diff artifact]"), 60_000);
  const candidateFinal = truncate(await readArtifact(args.candidate.finalMessagePath, "[no final message]"), 12_000);
  const baselineFinal = truncate(await readArtifact(args.baseline.finalMessagePath, "[no final message]"), 12_000);
  const candidateIsA = args.position === "candidate_first";

  return replaceAllLiteral(args.promptTemplate, {
    task_prompt: args.task.promptText,
    before_context: await beforeContext(args.task, candidateDiff, baselineDiff),
    diff_a: candidateIsA ? candidateDiff : baselineDiff,
    final_a: candidateIsA ? candidateFinal : baselineFinal,
    verify_a: verifyLabel(candidateIsA ? args.candidate : args.baseline),
    diff_b: candidateIsA ? baselineDiff : candidateDiff,
    final_b: candidateIsA ? baselineFinal : candidateFinal,
    verify_b: verifyLabel(candidateIsA ? args.baseline : args.candidate),
  });
}

export function normalizeJudgeOutput(value: unknown, position: JudgePosition): PairwiseJudgeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("judge result must be a JSON object");
  }

  const result = value as Partial<JudgeJson>;
  if (result.verdict !== "A" && result.verdict !== "B" && result.verdict !== "tie") {
    throw new Error("judge verdict must be A, B, or tie");
  }

  if (result.verdict === "tie") {
    return { verdict: "tie", scores: result.scores ?? null, rationale: result.rationale ?? "" };
  }

  const candidateIsA = position === "candidate_first";
  const candidateWon = (result.verdict === "A" && candidateIsA) || (result.verdict === "B" && !candidateIsA);

  return {
    verdict: candidateWon ? "candidate_win" : "baseline_win",
    scores: result.scores ?? null,
    rationale: result.rationale ?? "",
  };
}

export async function defaultJudgeExecutor(args: {
  task: EvalTaskRow;
  candidate: ReplayRunRow;
  baseline: ReplayRunRow;
  position: JudgePosition;
  promptTemplate: string;
  model: string;
  gatewayBaseUrl?: string;
}): Promise<PairwiseJudgeResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const prompt = await renderPairwisePrompt(args);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let text = "";
      for await (const message of query({
        prompt,
        options: {
          model: args.model,
          cwd: args.task.repoPath,
          permissionMode: "dontAsk",
          maxTurns: 1,
          tools: [],
          outputFormat: { type: "json_schema", schema: judgeOutputSchema },
          env: {
            ...Bun.env,
            ...(args.gatewayBaseUrl ? { ANTHROPIC_BASE_URL: args.gatewayBaseUrl } : {}),
            CLAUDE_AGENT_SDK_CLIENT_APP: "model-routing-evals-judge",
          },
        },
      })) {
        const maybeResult = message as { type?: string; result?: unknown };
        if (maybeResult.type === "result" && typeof maybeResult.result === "string") {
          text += maybeResult.result;
        }
      }

      return normalizeJudgeOutput(JSON.parse(text), args.position);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("judge failed");
}

function comparisonKey(candidateRunId: string, position: JudgePosition): string {
  return `${candidateRunId}:${position}`;
}

function okRunsByVariant(runs: ReplayRunRow[]): Map<string, ReplayRunRow> {
  return new Map(runs.filter((run) => run.status === "ok").map((run) => [run.variant, run]));
}

function toJudgmentRow(args: {
  task: EvalTaskRow;
  candidate: ReplayRunRow;
  baseline: ReplayRunRow;
  position: JudgePosition;
  result: PairwiseJudgeResult;
}): JudgmentRow {
  return {
    id: uuidv7(),
    evalTaskId: args.task.id,
    candidateRunId: args.candidate.id,
    baselineRunId: args.baseline.id,
    position: args.position,
    promptVersion: pairwisePromptVersion,
    createdAt: Date.now(),
    verdict: args.result.verdict,
    scoresJson: JSON.stringify(args.result.scores ?? null),
    rationale: args.result.rationale,
  };
}

export async function runJudgeStage(args: {
  dbPath: string;
  batchId: string;
  config: EvalConfig;
  models: ModelsConfig;
  promptPath?: string;
  gatewayBaseUrl?: string;
  executor?: JudgeExecutor;
}): Promise<{ tasks: number; insertedJudgments: number; skippedJudgments: number; missingBaselines: number }> {
  const tasks = listEvalTasksByBatch(args.dbPath, args.batchId);
  const promptTemplate = await readFile(args.promptPath ?? "config/prompts/pairwise-v1.md", "utf8");
  const model = judgeModel(args.config, args.models);
  const executor = args.executor ?? defaultJudgeExecutor;
  const positions: JudgePosition[] = args.config.judge.position_swap
    ? ["candidate_first", "baseline_first"]
    : ["candidate_first"];
  let insertedJudgments = 0;
  let skippedJudgments = 0;
  let missingBaselines = 0;

  for (const task of tasks) {
    const runs = okRunsByVariant(listReplayRunsForTask(args.dbPath, task.id));
    const baseline = runs.get(args.config.replay.baseline);
    if (!baseline) {
      missingBaselines += 1;
      continue;
    }

    const existing = new Set(
      listJudgmentsForTask(args.dbPath, task.id).map((judgment) =>
        comparisonKey(judgment.candidateRunId, judgment.position as JudgePosition),
      ),
    );
    const candidateRuns = [...runs.values()].filter((run) => run.id !== baseline.id);

    for (const candidate of candidateRuns) {
      for (const position of positions) {
        if (existing.has(comparisonKey(candidate.id, position))) {
          skippedJudgments += 1;
          continue;
        }

        const result = await executor({
          task,
          candidate,
          baseline,
          position,
          promptTemplate,
          model,
          gatewayBaseUrl: args.gatewayBaseUrl,
        });
        insertJudgment(args.dbPath, toJudgmentRow({ task, candidate, baseline, position, result }));
        insertedJudgments += 1;
      }
    }
  }

  return { tasks: tasks.length, insertedJudgments, skippedJudgments, missingBaselines };
}
