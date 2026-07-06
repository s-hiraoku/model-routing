import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const tierConfigSchema = z.object({
  model: z.string().min(1),
  match: z.array(z.string().min(1)),
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
