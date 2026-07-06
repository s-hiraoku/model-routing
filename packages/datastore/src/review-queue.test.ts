import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertEvalTask } from "./eval-tasks";
import { initializeDatabase } from "./init";
import { insertHumanReview, insertJudgment, insertReplayRun } from "./replay";
import { getReviewQueueItem, listReviewQueue } from "./review-queue";
import { insertTaskEvent, upsertSession } from "./task-events";

function seedTask(dbPath: string): void {
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

function seedRun(dbPath: string, idSuffix: string, variant: string): string {
  const id = `0197d239-7c00-7000-8000-0000000002${idSuffix}`;
  insertReplayRun(dbPath, {
    id,
    evalTaskId: "0197d239-7c00-7000-8000-000000000101",
    variant,
    createdAt: Number(idSuffix),
    status: "ok",
    durationMs: 10,
    turns: 1,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    totalCacheRead: 0,
    diffPath: `data/runs/${id}/changes.patch`,
    diffStat: "README.md | 1 +",
    finalMessagePath: `data/runs/${id}/final.md`,
    verifyPassed: true,
    errorMessage: null,
  });
  return id;
}

describe("review queue repositories", () => {
  test("lists unreviewed pairs and removes them after human review", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-review-queue-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      seedTask(dbPath);
      const baselineRunId = seedRun(dbPath, "01", "mid");
      const candidateRunId = seedRun(dbPath, "02", "low");
      insertJudgment(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000301",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        candidateRunId,
        baselineRunId,
        position: "candidate_first",
        promptVersion: "pairwise-v1",
        createdAt: 5,
        verdict: "candidate_win",
        scoresJson: "{}",
        rationale: "candidate",
      });
      insertJudgment(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000302",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        candidateRunId,
        baselineRunId,
        position: "baseline_first",
        promptVersion: "pairwise-v1",
        createdAt: 6,
        verdict: "baseline_win",
        scoresJson: "{}",
        rationale: "baseline",
      });

      const queue = listReviewQueue(dbPath, 10);
      expect(queue).toHaveLength(1);
      expect(queue[0]?.hasJudgeConflict).toBe(true);
      expect(queue[0]?.candidateVariant).toBe("low");
      expect(
        getReviewQueueItem(dbPath, {
          evalTaskId: "0197d239-7c00-7000-8000-000000000101",
          candidateRunId,
          baselineRunId,
        })?.judgmentSummary,
      ).toContain("candidate_first=candidate_win");

      insertHumanReview(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000401",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        candidateRunId,
        baselineRunId,
        createdAt: 7,
        source: "review_session",
        verdict: "tie",
        note: null,
        reviewSeconds: 12,
      });

      expect(listReviewQueue(dbPath, 10)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
