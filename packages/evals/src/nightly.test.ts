import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  insertRequestLog,
  insertShiftEvent,
  insertTaskEvent,
  upsertSession,
} from "@model-routing/datastore";
import type { FeedbackConfig, ModelsConfig } from "@model-routing/shared";
import { getNightlyReport, runNightly } from "./nightly";

const models: ModelsConfig = {
  tiers: {
    high: { model: "claude-opus-4-8", match: ["claude-opus-*"], strip_params: [] },
    mid: { model: "claude-fable-5", match: ["claude-fable-*"], strip_params: [] },
    low: { model: "claude-haiku-4-5-20251001", match: ["claude-haiku-*"], strip_params: [] },
  },
  never_touch: ["claude-haiku-*"],
  subscription: { window_hours: 5, eval_runs_per_window: 20 },
};

const feedbackConfig: FeedbackConfig = {
  attention_budget: {
    max_push_questions_per_week: 3,
    satisfaction_check_days: 30,
  },
  notifications: {
    enabled: false,
    review_ui_url: "http://127.0.0.1:8585",
  },
  rollback: {
    keep_policy_versions: 10,
  },
  implicit_signals: {
    correction_rate_jump: 1.5,
    min_n: 1,
  },
};

describe("nightly report", () => {
  test("reports correction-like tasks, unknown models, and shifted errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-nightly-"));
    const dbPath = join(dir, "model-routing.db");
    const now = 1_000_000;

    try {
      initializeDatabase(dbPath);
      upsertSession(dbPath, { id: "session-1", cwd: "/repo", gitRemote: null, seenAt: now });
      insertTaskEvent(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        sessionId: "session-1",
        createdAt: now,
        cwd: "/repo",
        gitHead: "abc",
        gitDirty: false,
        promptText: "まだ直ってない",
        promptHash: "hash",
        taskCategory: "debug",
        categorySource: "heuristic",
        categoryConfidence: 0.8,
        selfContained: true,
      });
      insertRequestLog(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000101",
        sessionId: null,
        replayRunId: null,
        createdAt: now,
        modelRequested: "claude-mystery-1",
        modelServed: "claude-haiku-4-5-20251001",
        isStreaming: false,
        messageCount: 1,
        toolCount: 0,
        hasToolResults: false,
        hasImages: false,
        systemHash: null,
        promptHash: "hash",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        status: "provider_error",
        httpStatus: 400,
        stopReason: null,
        latencyMs: 1,
        ttftMs: null,
        errorMessage: null,
        bodyPath: "body.zst",
      });
      insertShiftEvent(dbPath, {
        requestId: "0197d239-7c00-7000-8000-000000000101",
        createdAt: now,
        policyVersion: "test",
        taskEventId: null,
        decidedCategory: "debug",
        gearFrom: "mid",
        gearTo: "low",
        reason: "demote_task",
      });

      const report = getNightlyReport({ dbPath, models, feedbackConfig, now });
      expect(report.correctionLikeTasks).toBe(1);
      expect(report.unknownModels).toEqual(["claude-mystery-1"]);
      expect(report.shiftedErrors).toEqual([{ reason: "demote_task", count: 1 }]);
      expect(report.autoSuspends).toEqual([{ category: "debug", reason: "demote_task", count: 1 }]);

      const policyPath = join(dir, "shift-policy.yaml");
      const policyOut = join(dir, "shift-policy-out.yaml");
      await writeFile(
        policyPath,
        [
          "version: nightly-policy",
          "demote:",
          "  agent_step:",
          "    enabled: false",
          "  categories: {}",
          "promote:",
          "  categories: {}",
          "overrides: {}",
          "",
        ].join("\n"),
      );
      const written = await runNightly({
        dbPath,
        models,
        feedbackConfig,
        reportDir: join(dir, "reports"),
        policyPath,
        policyOut,
        now,
      });
      expect(await readFile(written.reportPath, "utf8")).toContain("claude-mystery-1");
      expect(await readFile(policyOut, "utf8")).toContain("auto_rollback:demote_task:errors=1");
      expect(await readFile(written.autoSuspend?.changelogPath ?? "", "utf8")).toContain('"origin": "auto_rollback"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
