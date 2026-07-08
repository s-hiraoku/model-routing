import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase, type TierProfileRow, upsertTierProfile } from "@model-routing/datastore";
import { detectDrift, formatDriftReport, getDriftReport } from "./drift";

function profile(overrides: Partial<TierProfileRow>): TierProfileRow {
  return {
    batchId: "from",
    variant: "low",
    taskCategory: "docs",
    n: 20,
    winRate: 0.5,
    wilsonLow: 0.4,
    wilsonHigh: 0.6,
    verifyPassRate: 1,
    avgTurns: 1,
    avgTotalTokens: 100,
    avgDurationMs: 1000,
    errorRate: 0,
    judgeHumanKappa: 0.8,
    ...overrides,
  };
}

describe("drift detection", () => {
  test("detects separated confidence intervals and large deltas", async () => {
    const warnings = detectDrift({
      fromBatch: "2026-W28",
      toBatch: "2026-W29",
      fromProfiles: [
        profile({ taskCategory: "docs", variant: "low", winRate: 0.5, wilsonLow: 0.4, wilsonHigh: 0.6 }),
        profile({ taskCategory: "debug", variant: "high", winRate: 0.6, wilsonLow: 0.5, wilsonHigh: 0.7 }),
        profile({ taskCategory: "test", variant: "low", n: 2, winRate: 0.1, wilsonLow: 0, wilsonHigh: 0.2 }),
      ],
      toProfiles: [
        profile({
          batchId: "to",
          taskCategory: "docs",
          variant: "low",
          winRate: 0.8,
          wilsonLow: 0.72,
          wilsonHigh: 0.9,
        }),
        profile({
          batchId: "to",
          taskCategory: "debug",
          variant: "high",
          winRate: 0.78,
          wilsonLow: 0.55,
          wilsonHigh: 0.9,
        }),
        profile({ batchId: "to", taskCategory: "test", variant: "low", n: 20, winRate: 0.8 }),
      ],
      minN: 10,
      minAbsDelta: 0.15,
    });

    expect(warnings).toMatchObject([
      { taskCategory: "docs", variant: "low", reason: "ci_separated" },
      { taskCategory: "debug", variant: "high", reason: "large_delta" },
    ]);
    expect(formatDriftReport({ fromBatch: "2026-W28", toBatch: "2026-W29", warnings })).toContain("docs | low");
  });

  test("loads profiles from datastore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-drift-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      upsertTierProfile(dbPath, profile({ batchId: "2026-W28", taskCategory: "docs", variant: "low" }));
      upsertTierProfile(
        dbPath,
        profile({
          batchId: "2026-W29",
          taskCategory: "docs",
          variant: "low",
          winRate: 0.8,
          wilsonLow: 0.72,
          wilsonHigh: 0.9,
        }),
      );

      expect(getDriftReport({ dbPath, fromBatch: "2026-W28", toBatch: "2026-W29" })).toMatchObject([
        { taskCategory: "docs", variant: "low" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
