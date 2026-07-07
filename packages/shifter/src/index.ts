import { readFile } from "node:fs/promises";
import type { ModelsConfig, RequestFeatures, TaskCategory, Tier } from "@model-routing/shared";
import { parse } from "yaml";
import { z } from "zod";

export type ShiftReason =
  | "demote_agent_step"
  | "demote_task"
  | "promote_task"
  | "override_force"
  | "hold"
  | "hold_sticky"
  | "quota_governor"
  | "degrade_guard";

export type ShiftDecision = {
  gear: Tier;
  reason: ShiftReason;
  policyVersion: string | null;
};

export type SessionShiftState = {
  taskEventId: string | null;
  category: TaskCategory | null;
  currentGear: Tier | null;
  demotedStreak: number;
  isTaskStart: boolean;
};

const tierSchema = z.enum(["high", "mid", "low"]);

export const shiftPolicySchema = z.object({
  version: z.string().min(1),
  demote: z
    .object({
      agent_step: z
        .object({
          enabled: z.boolean().default(false),
          to: tierSchema.default("low"),
          min_consecutive: z.number().int().positive().default(2),
        })
        .default({ enabled: false, to: "low", min_consecutive: 2 }),
      categories: z.record(z.string(), z.object({ to: tierSchema })).default({}),
    })
    .default({ agent_step: { enabled: false, to: "low", min_consecutive: 2 }, categories: {} }),
  promote: z
    .object({
      categories: z.record(z.string(), z.object({ to: tierSchema })).default({}),
    })
    .default({ categories: {} }),
  governor: z
    .object({
      quota_guard: z.boolean().default(true),
      window_burn_threshold: z.number().min(0).max(1).default(0.7),
      degrade_error_rate: z.number().min(0).max(1).default(0.3),
      degrade_pause_minutes: z.number().int().positive().default(15),
    })
    .default({ quota_guard: true, window_burn_threshold: 0.7, degrade_error_rate: 0.3, degrade_pause_minutes: 15 }),
  overrides: z
    .record(
      z.string(),
      z.object({
        action: z.enum(["none", "force"]).optional(),
        to: tierSchema.optional(),
        note: z.string().optional(),
      }),
    )
    .default({}),
});

export type ShiftPolicy = z.infer<typeof shiftPolicySchema>;

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function normalizeTier(model: string, models: ModelsConfig): Tier | null {
  if (models.never_touch.some((pattern) => globMatch(pattern, model))) {
    return null;
  }

  for (const tier of ["high", "mid", "low"] as const) {
    if (models.tiers[tier].match.some((pattern) => globMatch(pattern, model))) {
      return tier;
    }
  }

  return null;
}

export function withTier(features: RequestFeatures, models: ModelsConfig): RequestFeatures {
  return {
    ...features,
    tierRequested: normalizeTier(features.modelRequested, models),
  };
}

export function isAgentStep(features: RequestFeatures): boolean {
  return (
    features.hasToolResults &&
    features.lastUserText.trim().length < 40 &&
    features.toolCount > 0 &&
    features.approxInputTokens < 100_000
  );
}

function hold(features: RequestFeatures): ShiftDecision {
  return {
    gear: features.tierRequested ?? "mid",
    reason: "hold",
    policyVersion: null,
  };
}

export function decideShift(args: {
  features: RequestFeatures;
  state: SessionShiftState;
  policy: ShiftPolicy;
  enabled: boolean;
}): ShiftDecision {
  const { features, state, policy } = args;

  if (!args.enabled || !features.tierRequested) {
    return hold(features);
  }

  if (state.category && policy.overrides[state.category]?.action === "none") {
    return hold(features);
  }
  if (state.category) {
    const override = policy.overrides[state.category];
    if (override?.action === "force" && override.to) {
      return { gear: override.to, reason: "override_force", policyVersion: policy.version };
    }
  }

  if (isAgentStep(features) && policy.demote.agent_step.enabled) {
    if (state.demotedStreak + 1 >= policy.demote.agent_step.min_consecutive) {
      return {
        gear: policy.demote.agent_step.to,
        reason: "demote_agent_step",
        policyVersion: policy.version,
      };
    }

    return hold(features);
  }

  if (state.currentGear) {
    return {
      gear: state.currentGear,
      reason: "hold_sticky",
      policyVersion: policy.version,
    };
  }

  if (state.isTaskStart && state.category) {
    const promoted = policy.promote.categories[state.category];
    if (promoted) {
      return { gear: promoted.to, reason: "promote_task", policyVersion: policy.version };
    }

    const demoted = policy.demote.categories[state.category];
    if (demoted) {
      return { gear: demoted.to, reason: "demote_task", policyVersion: policy.version };
    }
  }

  return hold(features);
}

export async function loadShiftPolicy(path: string): Promise<ShiftPolicy> {
  const contents = await readFile(path, "utf8");
  return shiftPolicySchema.parse(parse(contents));
}
