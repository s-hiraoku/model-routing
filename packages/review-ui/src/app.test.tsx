import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  insertEvalTask,
  insertFeedbackNote,
  insertFeedbackProposal,
  insertJudgment,
  insertPreferenceQueueItem,
  insertReplayRun,
  insertTaskEvent,
  listFeedbackProposals,
  listPreferenceQueue,
  upsertSession,
} from "@model-routing/datastore";
import { createReviewUiApp } from "./app";

function seedTask(dbPath: string): void {
  upsertSession(dbPath, { id: "session-1", cwd: "/repo", gitRemote: null, seenAt: 1 });
  insertTaskEvent(dbPath, {
    id: "0197d239-7c00-7000-8000-000000000001",
    sessionId: "session-1",
    createdAt: 1,
    cwd: "/repo",
    gitHead: "abc",
    gitDirty: false,
    promptText: "README を更新して",
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
    promptText: "README を更新して",
    verifyCommand: null,
  });
}

async function seedRun(dbPath: string, dir: string, idSuffix: string, variant: string): Promise<string> {
  const id = `0197d239-7c00-7000-8000-0000000002${idSuffix}`;
  const runDir = join(dir, "runs", id);
  const diffPath = join(runDir, "changes.patch");
  const finalPath = join(runDir, "final.md");
  await mkdir(runDir, { recursive: true });
  await writeFile(diffPath, `diff for ${variant}`, { flag: "w" });
  await writeFile(finalPath, `final for ${variant}`, { flag: "w" });
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
    diffPath,
    diffStat: "README.md | 1 +",
    finalMessagePath: finalPath,
    verifyPassed: true,
    errorMessage: null,
  });
  return id;
}

describe("review-ui app", () => {
  test("renders queue, compares artifacts, and stores a human review", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-review-ui-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      seedTask(dbPath);
      const baselineRunId = await seedRun(dbPath, dir, "01", "mid");
      const candidateRunId = await seedRun(dbPath, dir, "02", "low");
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
      insertPreferenceQueueItem(dbPath, {
        id: "preference-1",
        batchId: "2026-W28",
        evalTaskId: "0197d239-7c00-7000-8000-000000000101",
        candidateRunId,
        baselineRunId,
        createdAt: 6,
        priority: 2,
        reason: "judge_conflict",
        dueAt: 100,
      });
      insertFeedbackNote(dbPath, {
        id: "feedback-1",
        createdAt: 7,
        source: "cli",
        text: "docs は mid に固定したい",
        status: "parsed",
        parsedJson: "{}",
      });
      insertFeedbackProposal(dbPath, {
        id: "proposal-1",
        feedbackNoteId: "feedback-1",
        createdAt: 8,
        kind: "policy_override",
        title: "Review docs routing preference",
        summary: "Route docs work toward mid.",
        proposalJson: JSON.stringify({ action: "add_override_candidate", category: "docs", desired_tier: "mid" }),
      });

      const app = createReviewUiApp({ dbPath });
      const queue = await app.request("/queue");
      const queueText = await queue.text();
      expect(queue.status).toBe(200);
      expect(queueText).toContain("README を更新して");
      expect(queueText).not.toContain("low");

      const compare = await app.request(
        `/compare/0197d239-7c00-7000-8000-000000000101/${candidateRunId}/${baselineRunId}`,
      );
      const compareText = await compare.text();
      expect(compare.status).toBe(200);
      expect(compareText).toContain("diff for low");
      expect(compareText).toContain("diff for mid");
      expect(compareText).not.toContain(">low<");
      expect(compareText).not.toContain(">mid<");

      const push = await app.request("/push");
      const pushText = await push.text();
      expect(push.status).toBe(200);
      expect(pushText).toContain("judge_conflict");

      const pushCompare = await app.request("/push/preference-1");
      const pushCompareText = await pushCompare.text();
      expect(pushCompare.status).toBe(200);
      expect(pushCompareText).toContain('name="preference_queue_id"');

      const proposals = await app.request("/proposals");
      const proposalsText = await proposals.text();
      expect(proposals.status).toBe(200);
      expect(proposalsText).toContain("Review docs routing preference");

      const proposal = await app.request("/proposals/proposal-1");
      const proposalText = await proposal.text();
      expect(proposal.status).toBe(200);
      expect(proposalText).toContain("desired_tier");
      expect(proposalText).toContain("mid");

      const decision = new FormData();
      decision.set("decision", "accepted");
      const decided = await app.request("/proposals/proposal-1", { method: "POST", body: decision });
      expect(decided.status).toBe(303);
      expect(listFeedbackProposals(dbPath, { status: "accepted" })).toMatchObject([{ id: "proposal-1" }]);

      const form = new FormData();
      form.set("eval_task_id", "0197d239-7c00-7000-8000-000000000101");
      form.set("candidate_run_id", candidateRunId);
      form.set("baseline_run_id", baselineRunId);
      form.set("preference_queue_id", "preference-1");
      form.set("started_at", String(Date.now() - 3000));
      form.set("verdict", "A");
      const posted = await app.request("/reviews", { method: "POST", body: form });
      expect(posted.status).toBe(303);

      const db = new Database(dbPath, { readonly: true });
      try {
        const review = db
          .query<{ verdict: string; source: string }, []>("SELECT verdict, source FROM human_reviews")
          .get();
        expect(review).toEqual({ verdict: "candidate_win", source: "push" });
      } finally {
        db.close();
      }
      expect(listPreferenceQueue(dbPath, { status: "answered" })).toMatchObject([
        { id: "preference-1", humanReviewId: expect.any(String) },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
