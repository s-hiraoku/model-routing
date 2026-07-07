import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  defaultDatabasePath,
  initializeDatabase,
  listFeedbackProposals,
  markFeedbackProposalApplied,
} from "@model-routing/datastore";
import { parse, stringify } from "yaml";

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue != null) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { command, positionals, flags };
}

function flagString(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : fallback;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run policy -- rollback <policy-file> [--out config/shift-policy.yaml]",
    "  bun run policy -- apply-feedback [--policy config/shift-policy.yaml] [--out config/shift-policy.yaml] [--db data/model-routing.db]",
  ].join("\n");
}

async function commandRollback(args: ParsedArgs): Promise<void> {
  const source = args.positionals[0];
  if (!source) {
    throw new Error("rollback requires a policy file");
  }

  const out = flagString(args, "out", "config/shift-policy.yaml");
  const parsed = parse(await readFile(source, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("policy file must contain a version");
  }

  await mkdir(dirname(out), { recursive: true });
  await copyFile(source, out);
  console.info(`rollback: ${parsed.version} -> ${out}`);
}

function isTier(value: unknown): value is "high" | "mid" | "low" {
  return value === "high" || value === "mid" || value === "low";
}

function overrideFromProposal(proposalJson: string): { category: string; tier: "high" | "mid" | "low" } | null {
  const parsed = JSON.parse(proposalJson) as Record<string, unknown>;
  if (parsed.action !== "add_override_candidate" || typeof parsed.category !== "string") {
    return null;
  }
  if (!isTier(parsed.desired_tier)) {
    return null;
  }
  return { category: parsed.category, tier: parsed.desired_tier };
}

async function commandApplyFeedback(args: ParsedArgs): Promise<void> {
  const dbPath = flagString(args, "db", defaultDatabasePath());
  const policyPath = flagString(args, "policy", "config/shift-policy.yaml");
  const out = flagString(args, "out", policyPath);
  const changelogPath = flagString(args, "changelog", "data/reports/feedback-policy-changelog.json");
  const now = flagString(args, "now", new Date().toISOString());
  initializeDatabase(dbPath);

  const proposals = listFeedbackProposals(dbPath, { status: "accepted", limit: 100 });
  const parsedPolicy = parse(await readFile(policyPath, "utf8")) as Record<string, unknown>;
  const overrides =
    parsedPolicy.overrides && typeof parsedPolicy.overrides === "object" && !Array.isArray(parsedPolicy.overrides)
      ? (parsedPolicy.overrides as Record<string, unknown>)
      : {};
  const changes: Array<{ proposal_id: string; category: string; to: string }> = [];

  for (const proposal of proposals) {
    const override = overrideFromProposal(proposal.proposalJson);
    if (!override) {
      continue;
    }

    overrides[override.category] = {
      action: "force",
      to: override.tier,
      note: `human_feedback:${proposal.id}`,
    };
    changes.push({ proposal_id: proposal.id, category: override.category, to: override.tier });
  }

  if (changes.length === 0) {
    console.info("apply-feedback: applied=0");
    return;
  }

  parsedPolicy.overrides = overrides;
  parsedPolicy.version = `${typeof parsedPolicy.version === "string" ? parsedPolicy.version : "policy"}.feedback-${now.replace(/\D/g, "").slice(0, 14)}`;
  parsedPolicy.generated_at = now;

  await mkdir(dirname(out), { recursive: true });
  await mkdir(dirname(changelogPath), { recursive: true });
  await writeFile(out, stringify(parsedPolicy));
  await writeFile(
    changelogPath,
    `${JSON.stringify(
      {
        policy_version: parsedPolicy.version,
        origin: "human_feedback",
        applied_at: now,
        changes,
      },
      null,
      2,
    )}\n`,
  );

  for (const change of changes) {
    markFeedbackProposalApplied(dbPath, { id: change.proposal_id, decidedAt: Date.parse(now) });
  }
  console.info(`apply-feedback: applied=${changes.length} policy=${out} changelog=${changelogPath}`);
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "rollback":
      await commandRollback(args);
      return;
    case "apply-feedback":
      await commandApplyFeedback(args);
      return;
    default:
      console.info(usage());
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
