import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFeedbackNotes } from "@model-routing/datastore";
import { main } from "./feedback";

describe("feedback CLI", () => {
  test("adds and lists feedback notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-feedback-cli-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      await main(["add", "lowに降ろしすぎ", "--source", "test", "--db", dbPath]);
      await main(["list", "--db", dbPath]);

      expect(listFeedbackNotes(dbPath)).toMatchObject([
        {
          source: "test",
          text: "lowに降ろしすぎ",
          status: "pending",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
