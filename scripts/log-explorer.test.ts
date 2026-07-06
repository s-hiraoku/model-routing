import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, insertRequestLog } from "@model-routing/datastore";
import { listRecentRequests } from "./log-explorer";

describe("listRecentRequests", () => {
  test("returns newest requests first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-log-explorer-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      for (const [id, createdAt] of [
        ["older", 1],
        ["newer", 2],
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
          bodyPath: "body.zst",
        });
      }

      expect(listRecentRequests(dbPath, 1).map((row) => row.id)).toEqual(["newer"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
