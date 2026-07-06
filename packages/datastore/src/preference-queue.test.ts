import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./init";
import {
  countPreferenceQueueItemsSince,
  expirePreferenceQueueItems,
  getPreferenceQueueItem,
  insertPreferenceQueueItem,
  listPreferenceQueue,
  markPreferenceQueueAnswered,
} from "./preference-queue";

describe("preference queue repository", () => {
  test("inserts unique pairs and counts active weekly items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-preference-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      const row = {
        id: "pref-1",
        batchId: "2026-W28",
        evalTaskId: "task-1",
        candidateRunId: "run-low",
        baselineRunId: "run-mid",
        createdAt: 100,
        priority: 2,
        reason: "judge_conflict",
        dueAt: 200,
      };

      expect(insertPreferenceQueueItem(dbPath, row)).toBe(true);
      expect(insertPreferenceQueueItem(dbPath, { ...row, id: "pref-duplicate" })).toBe(false);
      expect(
        insertPreferenceQueueItem(dbPath, {
          ...row,
          id: "pref-2",
          evalTaskId: "task-2",
          candidateRunId: "run-high",
          priority: 1,
          createdAt: 50,
        }),
      ).toBe(true);

      expect(listPreferenceQueue(dbPath, { status: "pending" }).map((item) => item.id)).toEqual(["pref-1", "pref-2"]);
      expect(countPreferenceQueueItemsSince(dbPath, { since: 75, statuses: ["pending", "notified"] })).toBe(1);
      expect(markPreferenceQueueAnswered(dbPath, { id: "pref-1", humanReviewId: "review-1", answeredAt: 300 })).toBe(
        true,
      );
      expect(getPreferenceQueueItem(dbPath, "pref-1")).toMatchObject({
        status: "answered",
        answeredAt: 300,
        humanReviewId: "review-1",
      });
      expect(markPreferenceQueueAnswered(dbPath, { id: "pref-1", humanReviewId: "review-2", answeredAt: 400 })).toBe(
        false,
      );
      expect(expirePreferenceQueueItems(dbPath, 250)).toBe(1);
      expect(getPreferenceQueueItem(dbPath, "pref-2")).toMatchObject({ status: "expired" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
