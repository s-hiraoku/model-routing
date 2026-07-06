import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, insertTaskEvent, upsertSession } from "@model-routing/datastore";
import { formatM1Report, getM1Report } from "./report";

describe("getM1Report", () => {
  test("summarizes classification and reproducible candidate counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-m1-report-"));
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
        promptHash: "hash-1",
        taskCategory: "docs",
        categorySource: "heuristic",
        categoryConfidence: 0.8,
        selfContained: true,
      });
      insertTaskEvent(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000002",
        sessionId: "session-1",
        createdAt: 2,
        cwd: "/repo",
        gitHead: "abc",
        gitDirty: true,
        promptText: "前の続き",
        promptHash: "hash-2",
        taskCategory: "unknown",
        categorySource: "heuristic",
        categoryConfidence: 0,
        selfContained: false,
      });

      const report = getM1Report(dbPath);
      expect(report.totalTaskEvents).toBe(2);
      expect(report.reproducibleTaskEvents).toBe(1);
      expect(formatM1Report(report)).toContain("docs: 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
