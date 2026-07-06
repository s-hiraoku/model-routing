import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertEvalTask, listEvalTasksByBatch, listSampleCandidates } from "./eval-tasks";
import { initializeDatabase } from "./init";
import {
  insertTaskEvent,
  listTaskEventsForClassification,
  updateTaskClassification,
  upsertSession,
} from "./task-events";

async function withDb<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "model-routing-eval-tasks-"));
  const dbPath = join(dir, "model-routing.db");

  try {
    initializeDatabase(dbPath);
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function seedTask(
  dbPath: string,
  row: {
    id: string;
    sessionId?: string;
    category?: string;
    confidence?: number;
    selfContained?: boolean | null;
    gitDirty?: boolean;
    promptHash?: string;
    cwd?: string;
  },
): void {
  const sessionId = row.sessionId ?? "session-1";
  upsertSession(dbPath, {
    id: sessionId,
    cwd: row.cwd ?? "/repo",
    gitRemote: "git@example.com/repo.git",
    seenAt: 1,
  });
  insertTaskEvent(dbPath, {
    id: row.id,
    sessionId,
    createdAt: Number(row.id.slice(-2)),
    cwd: row.cwd ?? "/repo",
    gitHead: "abc123",
    gitDirty: row.gitDirty ?? false,
    promptText: `prompt ${row.id}`,
    promptHash: row.promptHash ?? `hash-${row.id}`,
    taskCategory: row.category ?? "docs",
    categorySource: row.category ? "heuristic" : null,
    categoryConfidence: row.confidence ?? (row.category ? 0.8 : null),
    selfContained: row.selfContained ?? true,
  });
}

describe("eval task repositories", () => {
  test("updates classification candidates and inserts eval tasks", async () => {
    await withDb((dbPath) => {
      seedTask(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        category: "unknown",
        confidence: 0,
        selfContained: null,
      });

      const [candidate] = listTaskEventsForClassification(dbPath, 10);
      expect(candidate?.taskCategory).toBe("unknown");

      updateTaskClassification(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        taskCategory: "docs",
        categorySource: "llm",
        categoryConfidence: 0.9,
        selfContained: true,
      });

      insertEvalTask(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000101",
        taskEventId: "0197d239-7c00-7000-8000-000000000001",
        batchId: "2026-W28",
        createdAt: 3,
        taskCategory: "docs",
        repoPath: "/repo",
        baseCommit: "abc123",
        promptText: "prompt",
        verifyCommand: null,
      });

      expect(listEvalTasksByBatch(dbPath, "2026-W28")).toHaveLength(1);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ task_category: string }, []>("SELECT task_category FROM task_events").get()).toEqual({
          task_category: "docs",
        });
      } finally {
        db.close();
      }
    });
  });

  test("lists reproducible sample candidates and excludes used prompt hashes", async () => {
    await withDb((dbPath) => {
      seedTask(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000011",
        category: "docs",
        promptHash: "duplicate",
      });
      seedTask(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000012",
        category: "test",
        promptHash: "duplicate",
      });
      seedTask(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000013",
        category: "debug",
        gitDirty: true,
      });

      const candidates = listSampleCandidates(dbPath, {
        since: 0,
        excludeRepos: [],
        limit: 10,
      });

      expect(candidates.map((candidate) => candidate.taskEventId)).toEqual(["0197d239-7c00-7000-8000-000000000012"]);
    });
  });
});
