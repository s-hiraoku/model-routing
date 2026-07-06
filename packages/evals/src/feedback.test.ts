import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  insertEvalTask,
  insertJudgment,
  insertPreferenceQueueItem,
  insertReplayRun,
  insertTaskEvent,
  listPreferenceQueue,
  upsertSession,
} from "@model-routing/datastore";
import type { FeedbackConfig } from "@model-routing/shared";
import { runFeedbackStage } from "./feedback";

const feedbackConfig: FeedbackConfig = {
  attention_budget: {
    max_push_questions_per_week: 1,
    satisfaction_check_days: 30,
  },
  notifications: {
    enabled: false,
    review_ui_url: "http://127.0.0.1:8585",
  },
  rollback: {
    keep_policy_versions: 10,
  },
};

function seedPair(dbPath: string, suffix: string, verdicts: [string, string]): { taskId: string; candidateId: string } {
  const taskEventId = `task-event-${suffix}`;
  const taskId = `eval-task-${suffix}`;
  const baselineId = `baseline-${suffix}`;
  const candidateId = `candidate-${suffix}`;

  insertTaskEvent(dbPath, {
    id: taskEventId,
    sessionId: "session-1",
    createdAt: 1,
    cwd: "/repo",
    gitHead: "abc",
    gitDirty: false,
    promptText: `task ${suffix}`,
    promptHash: `hash-${suffix}`,
    taskCategory: "docs",
    categorySource: "heuristic",
    categoryConfidence: 0.8,
    selfContained: true,
  });
  insertEvalTask(dbPath, {
    id: taskId,
    taskEventId,
    batchId: "2026-W28",
    createdAt: 2,
    taskCategory: "docs",
    repoPath: "/repo",
    baseCommit: "abc",
    promptText: `task ${suffix}`,
    verifyCommand: null,
  });
  for (const [id, variant] of [
    [baselineId, "mid"],
    [candidateId, "low"],
  ] as const) {
    insertReplayRun(dbPath, {
      id,
      evalTaskId: taskId,
      variant,
      createdAt: 3,
      status: "ok",
      durationMs: 10,
      turns: 1,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCacheRead: 0,
      diffPath: null,
      diffStat: null,
      finalMessagePath: null,
      verifyPassed: true,
      errorMessage: null,
    });
  }
  for (const [index, position] of ["candidate_first", "baseline_first"].entries()) {
    insertJudgment(dbPath, {
      id: `judgment-${suffix}-${index}`,
      evalTaskId: taskId,
      candidateRunId: candidateId,
      baselineRunId: baselineId,
      position,
      promptVersion: "pairwise-v1",
      createdAt: 4 + index,
      verdict: verdicts[index],
      scoresJson: "{}",
      rationale: verdicts[index],
    });
  }

  return { taskId, candidateId };
}

describe("feedback stage", () => {
  test("queues the highest uncertainty review pairs within the weekly budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-feedback-stage-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      upsertSession(dbPath, { id: "session-1", cwd: "/repo", gitRemote: null, seenAt: 1 });
      const conflicted = seedPair(dbPath, "conflict", ["candidate_win", "baseline_win"]);
      seedPair(dbPath, "stable", ["candidate_win", "candidate_win"]);
      insertPreferenceQueueItem(dbPath, {
        id: "expired-pref",
        batchId: "2026-W28",
        evalTaskId: "expired-task",
        candidateRunId: "expired-candidate",
        baselineRunId: "expired-baseline",
        createdAt: Date.UTC(2026, 6, 6),
        priority: 1,
        reason: "review_queue",
        dueAt: Date.UTC(2026, 6, 5),
      });

      const result = runFeedbackStage({
        dbPath,
        batchId: "2026-W28",
        config: feedbackConfig,
        now: Date.UTC(2026, 6, 6),
      });

      expect(result).toMatchObject({ candidates: 2, expired: 1, inserted: 1, activeThisWeek: 0, budget: 1 });
      expect(listPreferenceQueue(dbPath, { status: "pending" })).toMatchObject([
        {
          evalTaskId: conflicted.taskId,
          candidateRunId: conflicted.candidateId,
          priority: 2,
          reason: "judge_conflict",
          status: "pending",
        },
      ]);
      expect(listPreferenceQueue(dbPath, { status: "expired" })).toMatchObject([{ id: "expired-pref" }]);

      const rerun = runFeedbackStage({
        dbPath,
        batchId: "2026-W28",
        config: feedbackConfig,
        now: Date.UTC(2026, 6, 6),
      });
      expect(rerun.inserted).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
