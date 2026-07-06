import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertEvalTask } from "./eval-tasks";
import { initializeDatabase } from "./init";
import { insertHumanReview, insertJudgment, insertReplayRun, listReplayRunsForTask } from "./replay";
import { insertTaskEvent, upsertSession } from "./task-events";

describe("replay repositories", () => {
  test("stores replay runs, judgments, and human reviews", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-replay-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
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
      insertReplayRun(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000201",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        variant: "mid",
        createdAt: 3,
        status: "ok",
        durationMs: 10,
        turns: 1,
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCacheRead: 0,
        diffPath: "data/runs/run/changes.patch",
        diffStat: "README.md | 1 +",
        finalMessagePath: "data/runs/run/final.md",
        verifyPassed: true,
        errorMessage: null,
      });
      insertReplayRun(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000202",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        variant: "low",
        createdAt: 4,
        status: "ok",
        durationMs: 12,
        turns: 1,
        totalInputTokens: 80,
        totalOutputTokens: 15,
        totalCacheRead: 0,
        diffPath: null,
        diffStat: null,
        finalMessagePath: null,
        verifyPassed: null,
        errorMessage: null,
      });

      insertJudgment(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000301",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        candidateRunId: "0197d239-7c00-7000-8000-000000000202",
        baselineRunId: "0197d239-7c00-7000-8000-000000000201",
        position: "candidate_first",
        promptVersion: "pairwise-v1",
        createdAt: 5,
        verdict: "tie",
        scoresJson: "{}",
        rationale: "same",
      });
      insertHumanReview(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000401",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        candidateRunId: "0197d239-7c00-7000-8000-000000000202",
        baselineRunId: "0197d239-7c00-7000-8000-000000000201",
        createdAt: 6,
        source: "review_session",
        verdict: "tie",
        note: null,
        reviewSeconds: 10,
      });

      expect(listReplayRunsForTask(dbPath, "0197d239-7c00-7000-8000-000000000101")).toHaveLength(2);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM judgments").get()?.count).toBe(1);
        expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM human_reviews").get()?.count).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
