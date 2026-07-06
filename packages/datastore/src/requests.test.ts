import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./init";
import { insertRequestLog } from "./requests";

describe("insertRequestLog", () => {
  test("inserts request metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-requests-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      insertRequestLog(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        sessionId: null,
        replayRunId: null,
        createdAt: 1,
        modelRequested: "claude-fable-5",
        modelServed: "claude-fable-5",
        isStreaming: true,
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
        latencyMs: 10,
        ttftMs: null,
        errorMessage: null,
        bodyPath: "data/bodies/2026-07/req.json.zst",
      });

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query<{ id: string; is_streaming: number }, []>("SELECT id, is_streaming FROM requests").get();
        expect(row).toEqual({
          id: "0197d239-7c00-7000-8000-000000000001",
          is_streaming: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
