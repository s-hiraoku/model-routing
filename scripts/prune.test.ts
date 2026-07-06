import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, insertRequestLog } from "@model-routing/datastore";
import { listPruneCandidates, pruneBodies } from "./prune";

describe("pruneBodies", () => {
  test("deletes body files older than the retention window", async () => {
    const dir = join(tmpdir(), `model-routing-prune-${Date.now()}`);
    const dbPath = join(dir, "model-routing.db");
    const oldBody = join(dir, "old.zst");
    const newBody = join(dir, "new.zst");
    const now = 100 * 24 * 60 * 60 * 1000;

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(oldBody, "old");
      await writeFile(newBody, "new");
      initializeDatabase(dbPath);
      for (const [id, createdAt, bodyPath] of [
        ["old", 1, oldBody],
        ["new", now, newBody],
      ] as const) {
        insertRequestLog(dbPath, {
          id,
          sessionId: null,
          replayRunId: null,
          createdAt,
          modelRequested: "claude-fable-5",
          modelServed: "claude-fable-5",
          isStreaming: false,
          messageCount: 1,
          toolCount: 0,
          hasToolResults: false,
          hasImages: false,
          systemHash: null,
          promptHash: "hash",
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          status: "ok",
          httpStatus: 200,
          stopReason: null,
          latencyMs: null,
          ttftMs: null,
          errorMessage: null,
          bodyPath,
        });
      }

      expect(listPruneCandidates(dbPath, now - 90 * 24 * 60 * 60 * 1000)).toHaveLength(1);
      expect(await pruneBodies(dbPath, now, 90)).toEqual({
        candidates: 1,
        deleted: 1,
        dryRun: false,
      });
      expect(existsSync(oldBody)).toBe(false);
      expect(existsSync(newBody)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
