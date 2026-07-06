import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertFeedbackNote, listFeedbackNotes } from "./feedback-notes";
import { initializeDatabase } from "./init";

describe("feedback notes repository", () => {
  test("stores and lists notes by status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-feedback-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      insertFeedbackNote(dbPath, {
        id: "note-1",
        createdAt: 100,
        source: "cli",
        text: "docs は low でよいが commit message は mid にしてほしい",
      });
      insertFeedbackNote(dbPath, {
        id: "note-2",
        createdAt: 200,
        source: "review-ui",
        text: "plan 系をもっと high に上げたい",
        status: "parsed",
        parsedJson: JSON.stringify({ category: "plan" }),
      });

      expect(listFeedbackNotes(dbPath).map((note) => note.id)).toEqual(["note-2", "note-1"]);
      expect(listFeedbackNotes(dbPath, { status: "pending" })).toMatchObject([
        {
          id: "note-1",
          source: "cli",
          status: "pending",
          parsedJson: null,
          resolution: null,
        },
      ]);
      expect(listFeedbackNotes(dbPath, { limit: 1 })).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
