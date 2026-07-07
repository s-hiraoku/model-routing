import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertFeedbackNote, listFeedbackNotes, markFeedbackNoteParsed } from "./feedback-notes";
import {
  decideFeedbackProposal,
  getFeedbackProposal,
  insertFeedbackProposal,
  listFeedbackProposals,
} from "./feedback-proposals";
import { initializeDatabase } from "./init";

describe("feedback proposals repository", () => {
  test("stores one proposal per feedback note and records decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-feedback-proposals-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      insertFeedbackNote(dbPath, {
        id: "note-1",
        createdAt: 100,
        source: "cli",
        text: "commit message は mid がいい",
      });

      expect(
        insertFeedbackProposal(dbPath, {
          id: "proposal-1",
          feedbackNoteId: "note-1",
          createdAt: 200,
          kind: "policy_override",
          title: "Keep commit-message tasks on mid",
          summary: "Commit-message requests should not be demoted to low.",
          proposalJson: JSON.stringify({ action: "add_override", category: "docs" }),
        }),
      ).toBe(true);
      expect(
        insertFeedbackProposal(dbPath, {
          id: "proposal-duplicate",
          feedbackNoteId: "note-1",
          createdAt: 201,
          kind: "policy_override",
          title: "Duplicate",
          summary: "Duplicate",
          proposalJson: "{}",
        }),
      ).toBe(false);
      expect(markFeedbackNoteParsed(dbPath, { id: "note-1", parsedJson: '{"intent":"prefer_mid"}' })).toBe(true);

      expect(listFeedbackNotes(dbPath, { status: "parsed" })).toMatchObject([
        { id: "note-1", parsedJson: '{"intent":"prefer_mid"}' },
      ]);
      expect(listFeedbackProposals(dbPath, { status: "pending" })).toMatchObject([
        {
          id: "proposal-1",
          feedbackNoteId: "note-1",
          kind: "policy_override",
          status: "pending",
        },
      ]);
      expect(decideFeedbackProposal(dbPath, { id: "proposal-1", status: "accepted", decidedAt: 300 })).toBe(true);
      expect(listFeedbackProposals(dbPath, { status: "accepted" })).toMatchObject([
        { id: "proposal-1", decidedAt: 300 },
      ]);
      expect(getFeedbackProposal(dbPath, "proposal-1")).toMatchObject({ id: "proposal-1", status: "accepted" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
