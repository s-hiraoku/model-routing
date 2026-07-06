import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskEventPayload } from "./notify-task";

describe("buildTaskEventPayload", () => {
  test("builds task event payload with git state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-hook-"));

    try {
      await Bun.$`git init`.cwd(dir).quiet();
      await Bun.$`git config user.email test@example.com`.cwd(dir).quiet();
      await Bun.$`git config user.name Test`.cwd(dir).quiet();
      await writeFile(join(dir, "README.md"), "hello");
      await Bun.$`git add README.md`.cwd(dir).quiet();
      await Bun.$`git commit -m init`.cwd(dir).quiet();

      const payload = await buildTaskEventPayload({
        session_id: "session-1",
        cwd: dir,
        prompt: "README を更新して",
      });

      expect(payload?.session_id).toBe("session-1");
      expect(payload?.cwd).toBe(dir);
      expect(payload?.prompt).toBe("README を更新して");
      expect(payload?.git_head).toHaveLength(40);
      expect(payload?.git_dirty).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null for malformed hook input", async () => {
    expect(await buildTaskEventPayload({ cwd: "/tmp", prompt: "hello" })).toBeNull();
  });
});
