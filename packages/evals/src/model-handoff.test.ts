import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, insertRequestLog } from "@model-routing/datastore";
import type { EvalConfig, ModelsConfig } from "@model-routing/shared";
import { buildModelHandoffPlan, formatModelHandoffPlan } from "./model-handoff";

const models: ModelsConfig = {
  tiers: {
    high: { model: "claude-opus-4-8", match: ["claude-opus-*"], strip_params: [] },
    mid: { model: "claude-sonnet-6", match: ["claude-sonnet-6"], strip_params: [] },
    low: { model: "claude-haiku-4-5", match: ["claude-haiku-*"], strip_params: ["output_config.effort"] },
  },
  never_touch: ["claude-haiku-*"],
  subscription: { window_hours: 5, eval_runs_per_window: 20 },
};

const config: EvalConfig = {
  sampling: {
    per_batch: 2,
    per_category_min: 1,
    self_contained_only: true,
    max_task_prompt_chars: 8000,
    dedup_window_days: 30,
    exclude_repos: [],
  },
  replay: {
    variants: [{ id: "high" }, { id: "mid" }, { id: "low" }, { id: "mid+demote" }],
    baseline: "mid",
    isolation: "worktree",
    timeout_minutes: 15,
    concurrency: 1,
    verify_commands: {},
    setup_commands: {},
  },
  judge: { primary: "high", position_swap: true },
  human_review: { sample_rate: 0.25, low_margin_always: true },
  schedule: { allowed_hours: [], pause_on_rate_limit: true },
  policy_generation: {
    demote_min_n: 10,
    demote_wilson_low: 0.4,
    promote_min_n: 10,
    promote_wilson_low: 0.55,
    min_kappa: 0.6,
  },
};

describe("model generation handoff", () => {
  test("builds a next-batch handoff plan from current model tiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-handoff-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      insertRequestLog(dbPath, {
        id: "request-1",
        sessionId: null,
        replayRunId: null,
        createdAt: 1_800_000_000_000,
        modelRequested: "claude-unknown-7",
        modelServed: "claude-unknown-7",
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
        bodyPath: "",
      });

      const plan = buildModelHandoffPlan({
        dbPath,
        batchId: "2026-W30",
        previousBatch: "2026-W29",
        models,
        config,
        modelsPath: "config/models.yaml",
        configPath: "config/eval.yaml",
        feedbackConfigPath: "config/feedback.yaml",
        policyPath: "config/shift-policy.yaml",
        reportDir: "data/reports",
        gatewayBaseUrl: "http://localhost:8484",
        now: 1_800_000_000_100,
      });

      expect(plan.unknownModels).toEqual(["claude-unknown-7"]);
      expect(plan.variants).toContainEqual({ id: "mid", model: "claude-sonnet-6" });
      expect(plan.variants).toContainEqual({ id: "mid+demote", model: "claude-sonnet-6" });
      expect(plan.estimate.totalRuns).toBe(20);
      expect(plan.commands.at(-1)).toBe("bun run evals -- drift --from 2026-W29 --to 2026-W30");
      expect(formatModelHandoffPlan(plan)).toContain("claude-sonnet-6");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
