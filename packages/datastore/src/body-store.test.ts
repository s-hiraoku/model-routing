import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyPathForRequest, writeZstdJson } from "./body-store";

describe("bodyPathForRequest", () => {
  test("uses year-month body directories", () => {
    expect(bodyPathForRequest("data", "req_1", new Date("2026-07-06T00:00:00Z"))).toBe(
      join("data", "bodies", "2026-07", "req_1.json.zst"),
    );
  });
});

describe("writeZstdJson", () => {
  test("writes zstd compressed JSON", async () => {
    const dir = join(tmpdir(), `model-routing-body-${Date.now()}`);
    const path = join(dir, "body.json.zst");

    try {
      await mkdir(dir, { recursive: true });
      await writeZstdJson(path, { ok: true });

      const proc = Bun.spawn(["zstd", "-q", "-d", "-c", path], {
        stdout: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({ ok: true });
      expect((await readFile(path)).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
