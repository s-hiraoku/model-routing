import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./init";
import { insertRequestLog } from "./requests";
import { getGatewayStats } from "./stats";

describe("getGatewayStats", () => {
  test("aggregates request, cache, model, and shift counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-stats-"));
    const dbPath = join(dir, "model-routing.db");
    const now = 1_000_000;

    try {
      initializeDatabase(dbPath);
      insertRequestLog(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        sessionId: null,
        replayRunId: null,
        createdAt: now,
        modelRequested: "claude-fable-5",
        modelServed: "claude-fable-5",
        isStreaming: false,
        messageCount: 1,
        toolCount: 0,
        hasToolResults: false,
        hasImages: false,
        systemHash: null,
        promptHash: "hash",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 25,
        cacheWriteTokens: null,
        status: "ok",
        httpStatus: 200,
        stopReason: null,
        latencyMs: 10,
        ttftMs: null,
        errorMessage: null,
        bodyPath: "body.zst",
      });

      const stats = getGatewayStats(dbPath, now);

      expect(stats.requests.total).toBe(1);
      expect(stats.requests.byStatus).toEqual({ ok: 1 });
      expect(stats.cache.hitRate).toBe(0.25);
      expect(stats.models["claude-fable-5"]).toEqual({
        requests: 1,
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(stats.shifts.byReason).toEqual({});
      expect(stats.shifts.byGear).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
