import { listTierProfilesByBatch, type TierProfileRow } from "@model-routing/datastore";

export type DriftWarning = {
  taskCategory: string;
  variant: string;
  fromBatch: string;
  toBatch: string;
  fromWinRate: number;
  toWinRate: number;
  delta: number;
  fromWilsonLow: number;
  fromWilsonHigh: number;
  toWilsonLow: number;
  toWilsonHigh: number;
  reason: "ci_separated" | "large_delta";
};

function key(profile: TierProfileRow): string {
  return `${profile.taskCategory}\u0000${profile.variant}`;
}

function intervalsSeparated(from: TierProfileRow, to: TierProfileRow): boolean {
  return to.wilsonLow > from.wilsonHigh || from.wilsonLow > to.wilsonHigh;
}

export function detectDrift(args: {
  fromBatch: string;
  toBatch: string;
  fromProfiles: TierProfileRow[];
  toProfiles: TierProfileRow[];
  minN?: number;
  minAbsDelta?: number;
}): DriftWarning[] {
  const minN = args.minN ?? 10;
  const minAbsDelta = args.minAbsDelta ?? 0.15;
  const fromByKey = new Map(args.fromProfiles.map((profile) => [key(profile), profile]));
  const warnings: DriftWarning[] = [];

  for (const to of args.toProfiles) {
    const from = fromByKey.get(key(to));
    if (!from || from.n < minN || to.n < minN) {
      continue;
    }

    const delta = to.winRate - from.winRate;
    const ciSeparated = intervalsSeparated(from, to);
    if (!ciSeparated && Math.abs(delta) < minAbsDelta) {
      continue;
    }

    warnings.push({
      taskCategory: to.taskCategory,
      variant: to.variant,
      fromBatch: args.fromBatch,
      toBatch: args.toBatch,
      fromWinRate: from.winRate,
      toWinRate: to.winRate,
      delta,
      fromWilsonLow: from.wilsonLow,
      fromWilsonHigh: from.wilsonHigh,
      toWilsonLow: to.wilsonLow,
      toWilsonHigh: to.wilsonHigh,
      reason: ciSeparated ? "ci_separated" : "large_delta",
    });
  }

  return warnings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.taskCategory.localeCompare(b.taskCategory));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDriftReport(args: { fromBatch: string; toBatch: string; warnings: DriftWarning[] }): string {
  const rows = args.warnings.map((warning) =>
    [
      warning.taskCategory,
      warning.variant,
      percent(warning.fromWinRate),
      percent(warning.toWinRate),
      percent(warning.delta),
      warning.reason,
    ].join(" | "),
  );

  return [
    `# Drift Report ${args.fromBatch} -> ${args.toBatch}`,
    "",
    "| category | variant | from | to | delta | reason |",
    "|---|---:|---:|---:|---:|---|",
    ...(rows.length > 0 ? rows : ["| - | - | - | - | - | none |"]),
    "",
  ].join("\n");
}

export function getDriftReport(args: {
  dbPath: string;
  fromBatch: string;
  toBatch: string;
  minN?: number;
  minAbsDelta?: number;
}): DriftWarning[] {
  return detectDrift({
    fromBatch: args.fromBatch,
    toBatch: args.toBatch,
    fromProfiles: listTierProfilesByBatch(args.dbPath, args.fromBatch),
    toProfiles: listTierProfilesByBatch(args.dbPath, args.toBatch),
    minN: args.minN,
    minAbsDelta: args.minAbsDelta,
  });
}
