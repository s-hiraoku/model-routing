import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  insertEvalTask,
  insertReplayRun,
  insertTaskEvent,
  listJudgmentsForTask,
  upsertSession,
} from "@model-routing/datastore";
import type { EvalConfig, ModelsConfig } from "@model-routing/shared";
import { judgeModel, normalizeJudgeOutput, runJudgeStage } from "./judge";

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

function insertRun(dbPath: string, idSuffix: string, variant: string): void {
  insertReplayRun(dbPath, {
    id: `0197d239-7c00-7000-8000-0000000002${idSuffix}`,
    evalTaskId: "0197d239-7c00-7000-8000-000000000101",
    variant,
    createdAt: Number(idSuffix),
    status: "ok",
    durationMs: 1,
    turns: 1,
    totalInputTokens: 10,
    totalOutputTokens: 2,
    totalCacheRead: 0,
    diffPath: null,
    diffStat: null,
    finalMessagePath: null,
    verifyPassed: true,
    errorMessage: null,
  });
}

describe("normalizeJudgeOutput", () => {
  test("maps A/B verdicts through candidate position", () => {
    expect(normalizeJudgeOutput({ verdict: "A", scores: {}, rationale: "a" }, "candidate_first").verdict).toBe(
      "candidate_win",
    );
    expect(normalizeJudgeOutput({ verdict: "A", scores: {}, rationale: "a" }, "baseline_first").verdict).toBe(
      "baseline_win",
    );
    expect(normalizeJudgeOutput({ verdict: "B", scores: {}, rationale: "b" }, "baseline_first").verdict).toBe(
      "candidate_win",
    );
    expect(normalizeJudgeOutput({ verdict: "tie", scores: {}, rationale: "t" }, "candidate_first").verdict).toBe("tie");
  });
});

describe("judgeModel", () => {
  test("resolves tier aliases and allows explicit model ids", () => {
    expect(judgeModel(config, models)).toBe("claude-opus-4-8");
    expect(judgeModel({ ...config, judge: { primary: "custom-model", position_swap: false } }, models)).toBe(
      "custom-model",
    );
  });
});

describe("runJudgeStage", () => {
  test("judges each non-baseline run with position swaps and skips existing judgments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-judge-stage-"));
    const dbPath = join(dir, "model-routing.db");
    const promptPath = join(dir, "pairwise-v1.md");

    try {
      await writeFile(promptPath, "{task_prompt} {diff_a} {diff_b}");
      initializeDatabase(dbPath);
      await seedEvalTask(dbPath);
      insertRun(dbPath, "01", "high");
      insertRun(dbPath, "02", "mid");
      insertRun(dbPath, "03", "low");
      insertRun(dbPath, "04", "mid+demote");

      const first = await runJudgeStage({
        dbPath,
        batchId: "2026-W28",
        config,
        models,
        promptPath,
        executor: async () => ({
          verdict: "candidate_win",
          scores: { A: { correctness: 5 }, B: { correctness: 4 } },
          rationale: "candidate is better",
        }),
      });
      const second = await runJudgeStage({
        dbPath,
        batchId: "2026-W28",
        config,
        models,
        promptPath,
        executor: async () => {
          throw new Error("should not run");
        },
      });

      expect(first).toEqual({ tasks: 1, insertedJudgments: 6, skippedJudgments: 0, missingBaselines: 0 });
      expect(second).toEqual({ tasks: 1, insertedJudgments: 0, skippedJudgments: 6, missingBaselines: 0 });
      expect(listJudgmentsForTask(dbPath, "0197d239-7c00-7000-8000-000000000101")).toHaveLength(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
