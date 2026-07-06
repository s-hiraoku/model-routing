import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  insertEvalTask,
  insertHumanReview,
  insertJudgment,
  insertReplayRun,
  insertTaskEvent,
  listTierProfilesByBatch,
  upsertSession,
} from "@model-routing/datastore";
import type { EvalConfig } from "@model-routing/shared";
import { aggregateProfiles, cohenKappa, runAggregateStage, wilsonInterval } from "./aggregate";

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
    variants: [{ id: "high" }, { id: "mid" }, { id: "low" }],
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

function seedTask(dbPath: string, suffix: string, category: string): string {
  const taskEventId = `0197d239-7c00-7000-8000-0000000000${suffix}`;
  const evalTaskId = `0197d239-7c00-7000-8000-0000000001${suffix}`;
  upsertSession(dbPath, { id: "session-1", cwd: "/repo", gitRemote: null, seenAt: 1 });
  insertTaskEvent(dbPath, {
    id: taskEventId,
    sessionId: "session-1",
    createdAt: Number(suffix),
    cwd: "/repo",
    gitHead: "abc",
    gitDirty: false,
    promptText: "README",
    promptHash: `hash-${suffix}`,
    taskCategory: category,
    categorySource: "heuristic",
    categoryConfidence: 0.8,
    selfContained: true,
  });
  insertEvalTask(dbPath, {
    id: evalTaskId,
    taskEventId,
    batchId: "2026-W28",
    createdAt: Number(suffix),
    taskCategory: category,
    repoPath: "/repo",
    baseCommit: "abc",
    promptText: "README",
    verifyCommand: null,
  });
  return evalTaskId;
}

function seedRun(dbPath: string, evalTaskId: string, suffix: string, variant: string): string {
  const id = `0197d239-7c00-7000-8000-0000000002${suffix}`;
  insertReplayRun(dbPath, {
    id,
    evalTaskId,
    variant,
    createdAt: Number(suffix),
    status: "ok",
    durationMs: 100,
    turns: 2,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    totalCacheRead: 30,
    diffPath: null,
    diffStat: null,
    finalMessagePath: null,
    verifyPassed: true,
    errorMessage: null,
  });
  return id;
}

function seedJudgment(
  dbPath: string,
  args: {
    suffix: string;
    evalTaskId: string;
    candidateRunId: string;
    baselineRunId: string;
    position: string;
    verdict: string;
  },
): void {
  insertJudgment(dbPath, {
    id: `0197d239-7c00-7000-8000-0000000003${args.suffix}`,
    evalTaskId: args.evalTaskId,
    candidateRunId: args.candidateRunId,
    baselineRunId: args.baselineRunId,
    position: args.position,
    promptVersion: "pairwise-v1",
    createdAt: Number(args.suffix),
    verdict: args.verdict,
    scoresJson: "{}",
    rationale: null,
  });
}

describe("aggregate helpers", () => {
  test("computes Wilson interval and kappa", () => {
    const interval = wilsonInterval(8, 10);
    expect(interval.low).toBeGreaterThan(0.4);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(
      cohenKappa([
        { judge: "candidate_win", human: "candidate_win" },
        { judge: "baseline_win", human: "tie" },
      ]),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("runAggregateStage", () => {
  test("uses human reviews as overrides and writes tier profiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-aggregate-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      const taskOne = seedTask(dbPath, "01", "docs");
      const baseOne = seedRun(dbPath, taskOne, "01", "mid");
      const lowOne = seedRun(dbPath, taskOne, "02", "low");
      seedJudgment(dbPath, {
        suffix: "01",
        evalTaskId: taskOne,
        candidateRunId: lowOne,
        baselineRunId: baseOne,
        position: "candidate_first",
        verdict: "candidate_win",
      });
      seedJudgment(dbPath, {
        suffix: "02",
        evalTaskId: taskOne,
        candidateRunId: lowOne,
        baselineRunId: baseOne,
        position: "baseline_first",
        verdict: "candidate_win",
      });
      insertHumanReview(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000401",
        evalTaskId: taskOne,
        candidateRunId: lowOne,
        baselineRunId: baseOne,
        createdAt: 10,
        source: "review_session",
        verdict: "baseline_win",
        note: null,
        reviewSeconds: 12,
      });

      const taskTwo = seedTask(dbPath, "02", "docs");
      const baseTwo = seedRun(dbPath, taskTwo, "03", "mid");
      const lowTwo = seedRun(dbPath, taskTwo, "04", "low");
      seedJudgment(dbPath, {
        suffix: "03",
        evalTaskId: taskTwo,
        candidateRunId: lowTwo,
        baselineRunId: baseTwo,
        position: "candidate_first",
        verdict: "candidate_win",
      });
      seedJudgment(dbPath, {
        suffix: "04",
        evalTaskId: taskTwo,
        candidateRunId: lowTwo,
        baselineRunId: baseTwo,
        position: "baseline_first",
        verdict: "baseline_win",
      });

      const profiles = aggregateProfiles({ dbPath, batchId: "2026-W28", config });
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.variant).toBe("low");
      expect(profiles[0]?.n).toBe(2);
      expect(profiles[0]?.winRate).toBe(0.25);

      expect(runAggregateStage({ dbPath, batchId: "2026-W28", config })).toEqual({ profiles: 1 });
      expect(listTierProfilesByBatch(dbPath, "2026-W28")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
