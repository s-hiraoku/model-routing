import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listTierProfilesByBatch, type TierProfileRow } from "@model-routing/datastore";
import type { EvalConfig } from "@model-routing/shared";
import { parse, stringify } from "yaml";

type GeneratedPolicy = {
  version: string;
  generated_at: string;
  generated_from_batch: string;
  demote: {
    agent_step: {
      enabled: boolean;
      to: "low";
      min_consecutive: number;
      evidence?: Record<string, unknown>;
    };
    categories: Record<string, { to: "low"; evidence: Record<string, unknown> }>;
  };
  promote: {
    categories: Record<string, { to: "high"; evidence: Record<string, unknown> }>;
  };
  governor: {
    quota_guard: boolean;
    window_burn_threshold: number;
    degrade_error_rate: number;
    degrade_pause_minutes: number;
  };
  overrides: Record<string, unknown>;
};

function percent(value: number | null): string {
  return value == null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function numberCell(value: number | null): string {
  return value == null ? "-" : value.toFixed(2);
}

function evidence(profile: TierProfileRow): Record<string, unknown> {
  return {
    variant: profile.variant,
    win_rate: Number(profile.winRate.toFixed(4)),
    wilson_low: Number(profile.wilsonLow.toFixed(4)),
    n: profile.n,
    kappa: profile.judgeHumanKappa == null ? null : Number(profile.judgeHumanKappa.toFixed(4)),
    avg_total_tokens: profile.avgTotalTokens == null ? null : Number(profile.avgTotalTokens.toFixed(2)),
    error_rate: Number(profile.errorRate.toFixed(4)),
  };
}

function kappaPass(profile: TierProfileRow, config: EvalConfig): boolean {
  return profile.judgeHumanKappa != null && profile.judgeHumanKappa >= config.policy_generation.min_kappa;
}

function demotePass(profile: TierProfileRow, config: EvalConfig): boolean {
  return (
    profile.n >= config.policy_generation.demote_min_n &&
    profile.wilsonLow > config.policy_generation.demote_wilson_low &&
    profile.errorRate < 0.1 &&
    kappaPass(profile, config)
  );
}

function promotePass(profile: TierProfileRow, config: EvalConfig): boolean {
  return (
    profile.n >= config.policy_generation.promote_min_n &&
    profile.wilsonLow > config.policy_generation.promote_wilson_low &&
    profile.errorRate < 0.1 &&
    kappaPass(profile, config)
  );
}

async function loadOverrides(path?: string): Promise<Record<string, unknown>> {
  if (!path) {
    return {};
  }

  try {
    const parsed = parse(await readFile(path, "utf8")) as { overrides?: unknown };
    return parsed.overrides && typeof parsed.overrides === "object" && !Array.isArray(parsed.overrides)
      ? (parsed.overrides as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function buildShiftPolicy(args: {
  batchId: string;
  profiles: TierProfileRow[];
  config: EvalConfig;
  existingPolicyPath?: string;
  now?: Date;
}): Promise<GeneratedPolicy> {
  const policy: GeneratedPolicy = {
    version: `${args.batchId}.1`,
    generated_at: (args.now ?? new Date()).toISOString(),
    generated_from_batch: args.batchId,
    demote: {
      agent_step: { enabled: false, to: "low", min_consecutive: 2 },
      categories: {},
    },
    promote: { categories: {} },
    governor: {
      quota_guard: true,
      window_burn_threshold: 0.7,
      degrade_error_rate: 0.3,
      degrade_pause_minutes: 15,
    },
    overrides: await loadOverrides(args.existingPolicyPath),
  };

  for (const profile of args.profiles) {
    if ((profile.variant === "low" || profile.variant === "mid+demote") && demotePass(profile, args.config)) {
      if (profile.variant === "mid+demote") {
        policy.demote.agent_step = {
          enabled: true,
          to: "low",
          min_consecutive: 2,
          evidence: evidence(profile),
        };
      } else {
        policy.demote.categories[profile.taskCategory] = { to: "low", evidence: evidence(profile) };
      }
    }

    if (profile.variant === "high" && promotePass(profile, args.config)) {
      policy.promote.categories[profile.taskCategory] = { to: "high", evidence: evidence(profile) };
    }
  }

  return policy;
}

export function formatBatchReport(args: {
  batchId: string;
  profiles: TierProfileRow[];
  policy: GeneratedPolicy;
}): string {
  const rows = args.profiles.map((profile) =>
    [
      profile.taskCategory,
      profile.variant,
      profile.n.toString(),
      percent(profile.winRate),
      percent(profile.wilsonLow),
      percent(profile.wilsonHigh),
      percent(profile.verifyPassRate),
      numberCell(profile.avgTurns),
      numberCell(profile.avgTotalTokens),
      percent(profile.errorRate),
      numberCell(profile.judgeHumanKappa),
    ].join(" | "),
  );
  const demotions = Object.entries(args.policy.demote.categories).map(
    ([category, rule]) => `- ${category}: ${rule.to} (n=${rule.evidence.n}, wilson_low=${rule.evidence.wilson_low})`,
  );
  const promotions = Object.entries(args.policy.promote.categories).map(
    ([category, rule]) => `- ${category}: ${rule.to} (n=${rule.evidence.n}, wilson_low=${rule.evidence.wilson_low})`,
  );

  return [
    `# Evaluation Report ${args.batchId}`,
    "",
    "| category | variant | n | win_rate | wilson_low | wilson_high | verify | avg_turns | avg_tokens | error | kappa |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    rows.length === 0 ? "| - | - | 0 | - | - | - | - | - | - | - | - |" : "",
    "",
    "## Demotion Candidates",
    policyLine(args.policy.demote.agent_step.enabled, args.policy.demote.agent_step.evidence),
    ...(demotions.length > 0 ? demotions : ["- none"]),
    "",
    "## Promotion Candidates",
    ...(promotions.length > 0 ? promotions : ["- none"]),
    "",
    "## Generated Policy",
    `- version: ${args.policy.version}`,
    `- overrides_preserved: ${Object.keys(args.policy.overrides).length}`,
    "",
  ]
    .filter((line, index, list) => line !== "" || list[index - 1] !== "")
    .join("\n");
}

function policyLine(enabled: boolean, evidenceValue: Record<string, unknown> | undefined): string {
  if (!enabled) {
    return "- agent_step: disabled";
  }

  return `- agent_step: low (n=${evidenceValue?.n}, wilson_low=${evidenceValue?.wilson_low})`;
}

export async function runReportStage(args: {
  dbPath: string;
  batchId: string;
  config: EvalConfig;
  reportDir: string;
  policyOut: string;
  existingPolicyPath?: string;
  now?: Date;
}): Promise<{ reportPath: string; policyPath: string; changelogPath: string; profiles: number }> {
  const profiles = listTierProfilesByBatch(args.dbPath, args.batchId);
  const policy = await buildShiftPolicy({
    batchId: args.batchId,
    profiles,
    config: args.config,
    existingPolicyPath: args.existingPolicyPath,
    now: args.now,
  });
  const reportPath = join(args.reportDir, `${args.batchId}.md`);
  const changelogPath = join(args.reportDir, `${args.batchId}-policy-changelog.json`);
  const report = formatBatchReport({ batchId: args.batchId, profiles, policy });
  const changelog = {
    policy_version: policy.version,
    generated_from_batch: args.batchId,
    origin: "auto_evidence",
    changes: {
      demote_agent_step: policy.demote.agent_step.enabled ? policy.demote.agent_step : null,
      demote_categories: policy.demote.categories,
      promote_categories: policy.promote.categories,
    },
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(args.policyOut), { recursive: true });
  await writeFile(reportPath, report);
  await writeFile(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  await writeFile(args.policyOut, stringify(policy));

  return { reportPath, policyPath: args.policyOut, changelogPath, profiles: profiles.length };
}
