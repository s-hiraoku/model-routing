import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./init";
import { insertTaskEvent, upsertSession } from "./task-events";

describe("task event repositories", () => {
  test("upserts sessions and inserts task events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-task-event-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      upsertSession(dbPath, {
        id: "session-1",
        cwd: "/repo",
        gitRemote: "git@example.com/repo.git",
        seenAt: 1,
      });
      insertTaskEvent(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        sessionId: "session-1",
        createdAt: 2,
        cwd: "/repo",
        gitHead: "abc123",
        gitDirty: false,
        promptText: "README を更新して",
        promptHash: "hash",
        taskCategory: "docs",
        categorySource: "heuristic",
        categoryConfidence: 0.8,
        selfContained: null,
      });

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ id: string }, []>("SELECT id FROM sessions").get()).toEqual({ id: "session-1" });
        expect(
          db
            .query<{ task_category: string; git_dirty: number }, []>("SELECT task_category, git_dirty FROM task_events")
            .get(),
        ).toEqual({ task_category: "docs", git_dirty: 0 });
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
