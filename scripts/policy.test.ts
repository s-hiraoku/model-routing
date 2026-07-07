import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideFeedbackProposal,
  getFeedbackProposal,
  initializeDatabase,
  insertFeedbackNote,
  insertFeedbackProposal,
} from "@model-routing/datastore";
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

  test("applies accepted feedback proposals to policy overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-policy-feedback-"));
    const dbPath = join(dir, "model-routing.db");
    const policy = join(dir, "config", "shift-policy.yaml");
    const out = join(dir, "out", "shift-policy.yaml");
    const changelog = join(dir, "reports", "feedback-changelog.json");

    try {
      initializeDatabase(dbPath);
      insertFeedbackNote(dbPath, {
        id: "note-1",
        createdAt: 1,
        source: "cli",
        text: "docs は mid に固定したい",
        status: "parsed",
        parsedJson: "{}",
      });
      insertFeedbackProposal(dbPath, {
        id: "proposal-1",
        feedbackNoteId: "note-1",
        createdAt: 2,
        kind: "policy_override",
        title: "Review docs routing preference",
        summary: "Route docs work toward mid.",
        proposalJson: JSON.stringify({ action: "add_override_candidate", category: "docs", desired_tier: "mid" }),
      });
      decideFeedbackProposal(dbPath, { id: "proposal-1", status: "accepted", decidedAt: 3 });
      await mkdir(join(dir, "config"), { recursive: true });
      await writeFile(
        policy,
        [
          "version: 2026-W28.1",
          "demote:",
          "  agent_step:",
          "    enabled: false",
          "  categories: {}",
          "promote:",
          "  categories: {}",
          "overrides:",
          "  review:",
          "    action: none",
          "",
        ].join("\n"),
        { flag: "w" },
      );

      await main([
        "apply-feedback",
        "--db",
        dbPath,
        "--policy",
        policy,
        "--out",
        out,
        "--changelog",
        changelog,
        "--now",
        "2026-07-08T00:00:00.000Z",
      ]);

      const written = await readFile(out, "utf8");
      expect(written).toContain("version: 2026-W28.1.feedback-20260708000000");
      expect(written).toContain("docs:");
      expect(written).toContain("action: force");
      expect(written).toContain("to: mid");
      expect(await readFile(changelog, "utf8")).toContain('"origin": "human_feedback"');
      expect(getFeedbackProposal(dbPath, "proposal-1")).toMatchObject({ status: "applied" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
