import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, type TierProfileRow, upsertTierProfile } from "@model-routing/datastore";
import type { EvalConfig } from "@model-routing/shared";
import { buildShiftPolicy, formatBatchReport, runReportStage } from "./policy";

const config: EvalConfig = {
  sampling: {
    per_batch: 20,
    per_category_min: 3,
    self_contained_only: true,
    max_task_prompt_chars: 8000,
    dedup_window_days: 30,
    exclude_repos: [],
  },
  replay: {
    variants: [{ id: "high" }, { id: "mid" }, { id: "low" }, { id: "mid+demote" }],
    baseline: "mid",
    isolation: "worktree",
    timeout_minutes: 15,
    concurrency: 1,
    verify_commands: {},
    setup_commands: {},
  },
  judge: { primary: "high", position_swap: true },
  human_review: { sample_rate: 0.25, low_margin_always: true },
  schedule: { allowed_hours: [], pause_on_rate_limit: true },
  policy_generation: {
    demote_min_n: 10,
    demote_wilson_low: 0.4,
    promote_min_n: 10,
    promote_wilson_low: 0.55,
    min_kappa: 0.6,
  },
};

function profile(overrides: Partial<TierProfileRow>): TierProfileRow {
  return {
    batchId: "2026-W28",
    variant: "low",
    taskCategory: "docs",
    n: 12,
    winRate: 0.5,
    wilsonLow: 0.42,
    wilsonHigh: 0.7,
    verifyPassRate: 1,
    avgTurns: 2,
    avgTotalTokens: 100,
    avgDurationMs: 1000,
    errorRate: 0,
    judgeHumanKappa: 0.7,
    ...overrides,
  };
}

describe("buildShiftPolicy", () => {
  test("generates conservative demotion and promotion rules while preserving overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-policy-"));
    const existingPolicyPath = join(dir, "shift-policy.yaml");

    try {
      await writeFile(existingPolicyPath, "overrides:\n  review:\n    action: none\n");
      const policy = await buildShiftPolicy({
        batchId: "2026-W28",
        config,
        existingPolicyPath,
        now: new Date("2026-07-06T00:00:00.000Z"),
        profiles: [
          profile({ variant: "low", taskCategory: "docs" }),
          profile({ variant: "high", taskCategory: "debug", wilsonLow: 0.6, winRate: 0.7 }),
          profile({ variant: "mid+demote", taskCategory: "test", wilsonLow: 0.45 }),
          profile({ variant: "low", taskCategory: "review", judgeHumanKappa: 0.3 }),
        ],
      });

      expect(policy.demote.categories.docs?.to).toBe("low");
      expect(policy.promote.categories.debug?.to).toBe("high");
      expect(policy.demote.agent_step.enabled).toBe(true);
      expect(policy.overrides).toEqual({ review: { action: "none" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatBatchReport", () => {
  test("renders profile and policy sections", async () => {
    const policy = await buildShiftPolicy({
      batchId: "2026-W28",
      config,
      profiles: [profile({})],
      now: new Date("2026-07-06T00:00:00.000Z"),
    });
    const report = formatBatchReport({ batchId: "2026-W28", profiles: [profile({})], policy });

    expect(report).toContain("# Evaluation Report 2026-W28");
    expect(report).toContain("docs | low | 12");
    expect(report).toContain("Demotion Candidates");
  });
});

describe("runReportStage", () => {
  test("writes report and policy files from tier profiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-report-"));
    const dbPath = join(dir, "model-routing.db");
    const reportDir = join(dir, "reports");
    const policyOut = join(dir, "policies", "shift-policy.yaml");

    try {
      initializeDatabase(dbPath);
      upsertTierProfile(dbPath, profile({}));
      const result = await runReportStage({
        dbPath,
        batchId: "2026-W28",
        config,
        reportDir,
        policyOut,
        now: new Date("2026-07-06T00:00:00.000Z"),
      });

      expect(result.profiles).toBe(1);
      expect(await readFile(result.reportPath, "utf8")).toContain("Evaluation Report");
      expect(await readFile(result.policyPath, "utf8")).toContain("generated_from_batch: 2026-W28");
      expect(await readFile(result.changelogPath, "utf8")).toContain("auto_evidence");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
