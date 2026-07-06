import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const tierConfigSchema = z.object({
  model: z.string().min(1),
  match: z.array(z.string().min(1)),
  strip_params: z.array(z.string().min(1)).default([]),
});

export const modelsConfigSchema = z.object({
  tiers: z.object({
    high: tierConfigSchema,
    mid: tierConfigSchema,
    low: tierConfigSchema,
  }),
  never_touch: z.array(z.string().min(1)).default([]),
  subscription: z.object({
    window_hours: z.number().positive(),
    eval_runs_per_window: z.number().int().positive(),
  }),
});

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;

export async function loadModelsConfig(path = "config/models.yaml"): Promise<ModelsConfig> {
  const contents = await readFile(path, "utf8");
  return modelsConfigSchema.parse(parse(contents));
}

export const evalConfigSchema = z.object({
  sampling: z.object({
    per_batch: z.number().int().positive(),
    per_category_min: z.number().int().nonnegative(),
    self_contained_only: z.boolean().default(true),
    max_task_prompt_chars: z.number().int().positive(),
    dedup_window_days: z.number().int().positive(),
    exclude_repos: z.array(z.string()).default([]),
  }),
  replay: z.object({
    variants: z.array(z.object({ id: z.string().min(1) })).min(1),
    baseline: z.string().min(1),
    isolation: z.string().min(1),
    timeout_minutes: z.number().int().positive(),
    concurrency: z.number().int().positive(),
    verify_commands: z.record(z.string(), z.string()).default({}),
    setup_commands: z.record(z.string(), z.string()).default({}),
  }),
  judge: z.object({
    primary: z.string().min(1),
    position_swap: z.boolean(),
  }),
  human_review: z.object({
    sample_rate: z.number().min(0).max(1),
    low_margin_always: z.boolean(),
  }),
  schedule: z.object({
    allowed_hours: z.array(z.number().int().min(0).max(23)).default([]),
    pause_on_rate_limit: z.boolean().default(true),
  }),
  policy_generation: z.object({
    demote_min_n: z.number().int().positive(),
    demote_wilson_low: z.number().min(0).max(1),
    promote_min_n: z.number().int().positive(),
    promote_wilson_low: z.number().min(0).max(1),
    min_kappa: z.number().min(0).max(1),
  }),
});

export type EvalConfig = z.infer<typeof evalConfigSchema>;

export async function loadEvalConfig(path = "config/eval.yaml"): Promise<EvalConfig> {
  const contents = await readFile(path, "utf8");
  return evalConfigSchema.parse(parse(contents));
}

export const feedbackConfigSchema = z.object({
  attention_budget: z.object({
    max_push_questions_per_week: z.number().int().nonnegative(),
    satisfaction_check_days: z.number().int().positive(),
  }),
  notifications: z.object({
    enabled: z.boolean(),
    review_ui_url: z.string().url(),
  }),
  rollback: z.object({
    keep_policy_versions: z.number().int().positive(),
  }),
});

export type FeedbackConfig = z.infer<typeof feedbackConfigSchema>;

export async function loadFeedbackConfig(path = "config/feedback.yaml"): Promise<FeedbackConfig> {
  const contents = await readFile(path, "utf8");
  return feedbackConfigSchema.parse(parse(contents));
}
