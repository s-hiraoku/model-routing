import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelsConfig } from "./config";

describe("loadModelsConfig", () => {
  test("loads and validates models yaml", async () => {
    const config = await loadModelsConfig("config/models.yaml");

    expect(config.tiers.high.model).toBe("claude-opus-4-8");
    expect(config.tiers.mid.match).toContain("claude-fable-*");
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
