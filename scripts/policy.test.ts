import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./policy";

describe("policy CLI", () => {
  test("rolls back by copying a versioned policy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-policy-cli-"));
    const source = join(dir, "shift-policy-old.yaml");
    const out = join(dir, "config", "shift-policy.yaml");

    try {
      await writeFile(source, "version: old-policy\ndemote: {}\n");
      await main(["rollback", source, "--out", out]);

      expect(await readFile(out, "utf8")).toContain("version: old-policy");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
