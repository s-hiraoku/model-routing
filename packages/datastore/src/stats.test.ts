import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./init";
import { insertRequestLog } from "./requests";
import { insertShiftEvent } from "./shift-events";
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
      insertRequestLog(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000002",
        sessionId: null,
        replayRunId: null,
        createdAt: now,
        modelRequested: "claude-fable-5",
        modelServed: "claude-haiku-4-5-20251001",
        isStreaming: false,
        messageCount: 1,
        toolCount: 0,
        hasToolResults: false,
        hasImages: false,
        systemHash: null,
        promptHash: "hash-2",
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: null,
        status: "ok",
        httpStatus: 200,
        stopReason: null,
        latencyMs: 10,
        ttftMs: null,
        errorMessage: null,
        bodyPath: "body-2.zst",
      });
      insertShiftEvent(dbPath, {
        requestId: "0197d239-7c00-7000-8000-000000000002",
        createdAt: now,
        policyVersion: "test",
        taskEventId: null,
        decidedCategory: "docs",
        gearFrom: "mid",
        gearTo: "low",
        reason: "demote_task",
      });

      const stats = getGatewayStats(dbPath, now);

      expect(stats.requests.total).toBe(2);
      expect(stats.requests.byStatus).toEqual({ ok: 2 });
      expect(stats.cache.hitRate).toBe(0.3333333333333333);
      expect(stats.cache.byShift.unshifted.hitRate).toBe(0.2);
      expect(stats.cache.byShift.shifted.hitRate).toBe(0.5);
      expect(stats.models["claude-fable-5"]).toEqual({
        requests: 1,
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(stats.shifts.byReason).toEqual({ demote_task: 1 });
      expect(stats.shifts.byGear).toEqual({ "mid->low": 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
