import { describe, expect, test } from "bun:test";
import type { ModelsConfig, RequestFeatures } from "@model-routing/shared";
import { decideShift, isAgentStep, normalizeTier, type SessionShiftState, type ShiftPolicy, withTier } from ".";

const models: ModelsConfig = {
  tiers: {
    high: { model: "claude-opus-4-8", match: ["claude-opus-*"], strip_params: [] },
    mid: { model: "claude-fable-5", match: ["claude-fable-*", "claude-sonnet-*"], strip_params: [] },
    low: { model: "claude-haiku-4-5-20251001", match: ["claude-haiku-*"], strip_params: ["output_config.effort"] },
  },
  never_touch: ["claude-haiku-*"],
  subscription: { window_hours: 5, eval_runs_per_window: 20 },
};

const policy: ShiftPolicy = {
  version: "test",
  demote: {
    agent_step: { enabled: true, to: "low", min_consecutive: 2 },
    categories: { docs: { to: "low" } },
  },
  promote: {
    categories: { debug: { to: "high" } },
  },
  governor: {
    quota_guard: true,
    window_burn_threshold: 0.7,
    degrade_error_rate: 0.3,
    degrade_pause_minutes: 15,
  },
  overrides: {},
};

const baseFeatures: RequestFeatures = {
  modelRequested: "claude-fable-5",
  tierRequested: "mid",
  isStreaming: true,
  messageCount: 3,
  toolCount: 0,
  hasToolResults: false,
  hasImages: false,
  systemHash: null,
  promptHash: "hash",
  approxInputTokens: 1000,
  lastUserText: "implement",
};

const baseState: SessionShiftState = {
  taskEventId: null,
  category: null,
  currentGear: null,
  demotedStreak: 0,
  isTaskStart: false,
};

describe("normalizeTier", () => {
  test("matches configured tiers and respects never_touch", () => {
    expect(normalizeTier("claude-fable-5", models)).toBe("mid");
    expect(normalizeTier("claude-opus-4-8", models)).toBe("high");
    expect(normalizeTier("claude-haiku-4-5-20251001", models)).toBeNull();
    expect(withTier({ ...baseFeatures, modelRequested: "unknown" }, models).tierRequested).toBeNull();
  });
});

describe("decideShift", () => {
  test("holds when disabled or tier is unknown", () => {
    expect(decideShift({ features: baseFeatures, state: baseState, policy, enabled: false })).toMatchObject({
      gear: "mid",
      reason: "hold",
    });
    expect(
      decideShift({ features: { ...baseFeatures, tierRequested: null }, state: baseState, policy, enabled: true }),
    ).toMatchObject({ reason: "hold" });
  });

  test("demotes only sustained agent steps", () => {
    const features = {
      ...baseFeatures,
      toolCount: 1,
      hasToolResults: true,
      lastUserText: "continue",
    };

    expect(isAgentStep(features)).toBe(true);
    expect(decideShift({ features, state: { ...baseState, demotedStreak: 0 }, policy, enabled: true })).toMatchObject({
      reason: "hold",
    });
    expect(decideShift({ features, state: { ...baseState, demotedStreak: 1 }, policy, enabled: true })).toMatchObject({
      gear: "low",
      reason: "demote_agent_step",
    });
  });

  test("promotes or demotes at task start and then stays sticky", () => {
    expect(
      decideShift({
        features: baseFeatures,
        state: { ...baseState, category: "debug", isTaskStart: true },
        policy,
        enabled: true,
      }),
    ).toMatchObject({ gear: "high", reason: "promote_task" });
    expect(
      decideShift({
        features: baseFeatures,
        state: { ...baseState, category: "docs", isTaskStart: true },
        policy,
        enabled: true,
      }),
    ).toMatchObject({ gear: "low", reason: "demote_task" });
    expect(
      decideShift({
        features: baseFeatures,
        state: { ...baseState, category: "docs", currentGear: "low" },
        policy,
        enabled: true,
      }),
    ).toMatchObject({ gear: "low", reason: "hold_sticky" });
  });

  test("category overrides force hold", () => {
    expect(
      decideShift({
        features: baseFeatures,
        state: { ...baseState, category: "docs", isTaskStart: true },
        policy: { ...policy, overrides: { docs: { action: "none" } } },
        enabled: true,
      }),
    ).toMatchObject({ gear: "mid", reason: "hold" });
    expect(
      decideShift({
        features: baseFeatures,
        state: { ...baseState, category: "docs", isTaskStart: true },
        policy: { ...policy, overrides: { docs: { action: "force", to: "high" } } },
        enabled: true,
      }),
    ).toMatchObject({ gear: "high", reason: "override_force" });
  });
});
