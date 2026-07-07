import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalConfig, loadFeedbackConfig, loadModelsConfig } from "./config";

describe("loadModelsConfig", () => {
  test("loads and validates models yaml", async () => {
    const config = await loadModelsConfig("config/models.yaml");

    expect(config.tiers.high.model).toBe("claude-opus-4-8");
    expect(config.tiers.mid.match).toContain("claude-fable-*");
    expect(config.tiers.low.strip_params).toEqual(["output_config.effort"]);
    expect(config.never_touch).toContain("claude-haiku-*");
  });

  test("fails on invalid config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-config-"));
    const path = join(dir, "models.yaml");

    try {
      await writeFile(path, "tiers: {}\n");
      await expect(loadModelsConfig(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadEvalConfig", () => {
  test("loads and validates eval yaml", async () => {
    const config = await loadEvalConfig("config/eval.yaml");

    expect(config.sampling.per_batch).toBe(20);
    expect(config.replay.variants.map((variant) => variant.id)).toContain("mid+demote");
    expect(config.schedule.allowed_hours).toContain(23);
  });
});

describe("loadFeedbackConfig", () => {
  test("loads and validates feedback yaml", async () => {
    const config = await loadFeedbackConfig("config/feedback.yaml");

    expect(config.attention_budget.max_push_questions_per_week).toBe(3);
    expect(config.notifications.review_ui_url).toBe("http://127.0.0.1:8585");
    expect(config.implicit_signals.min_n).toBe(20);
  });
});
