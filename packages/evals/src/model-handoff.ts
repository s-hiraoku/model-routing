import { countEvalTasksByBatch } from "@model-routing/datastore";
import type { EvalConfig, ModelsConfig } from "@model-routing/shared";
import { getNightlyReport } from "./nightly";
import { replayVariants } from "./replay";
import { estimateRuns, type SampleEstimate } from "./sample";

export type ModelHandoffPlan = {
  batchId: string;
  previousBatch: string | null;
  unknownModels: string[];
  tiers: Array<{ tier: string; model: string; match: string[] }>;
  variants: Array<{ id: string; model: string }>;
  estimate: SampleEstimate;
  commands: string[];
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function flag(name: string, value: string | undefined): string {
  return value ? ` --${name} ${shellQuote(value)}` : "";
}

export function buildModelHandoffPlan(args: {
  dbPath: string;
  batchId: string;
  previousBatch?: string;
  models: ModelsConfig;
  config: EvalConfig;
  modelsPath?: string;
  configPath?: string;
  feedbackConfigPath?: string;
  policyPath?: string;
  reportDir?: string;
  gatewayBaseUrl?: string;
  now?: number;
}): ModelHandoffPlan {
  const previousBatch = args.previousBatch || undefined;
  const existingTasks = countEvalTasksByBatch(args.dbPath, args.batchId);
  const taskCount = existingTasks || args.config.sampling.per_batch;
  const nightly = getNightlyReport({
    dbPath: args.dbPath,
    models: args.models,
    now: args.now,
  });
  const commands = [
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage classify${flag("models", args.modelsPath)}${flag(
      "config",
      args.configPath,
    )}`,
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage sample --yes${flag(
      "models",
      args.modelsPath,
    )}${flag("config", args.configPath)}`,
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage replay${flag(
      "models",
      args.modelsPath,
    )}${flag("config", args.configPath)}${flag("gateway", args.gatewayBaseUrl)}`,
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage judge${flag("models", args.modelsPath)}${flag(
      "config",
      args.configPath,
    )}${flag("gateway", args.gatewayBaseUrl)}`,
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage aggregate${flag(
      "models",
      args.modelsPath,
    )}${flag("config", args.configPath)}`,
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage report${flag(
      "models",
      args.modelsPath,
    )}${flag("config", args.configPath)}${flag("existing-policy", args.policyPath)}${flag(
      "report-dir",
      args.reportDir,
    )}`,
    `bun run evals -- run --batch ${shellQuote(args.batchId)} --stage feedback${flag(
      "feedback-config",
      args.feedbackConfigPath,
    )}`,
  ];

  if (previousBatch) {
    commands.push(`bun run evals -- drift --from ${shellQuote(previousBatch)} --to ${shellQuote(args.batchId)}`);
  }

  return {
    batchId: args.batchId,
    previousBatch: previousBatch ?? null,
    unknownModels: nightly.unknownModels,
    tiers: Object.entries(args.models.tiers).map(([tier, config]) => ({
      tier,
      model: config.model,
      match: config.match,
    })),
    variants: replayVariants(args.config, args.models),
    estimate: estimateRuns(
      taskCount,
      args.config.replay.variants.length,
      args.models.subscription.eval_runs_per_window,
    ),
    commands,
  };
}

export function formatModelHandoffPlan(plan: ModelHandoffPlan): string {
  const tierRows = plan.tiers.map((tier) => `| ${tier.tier} | ${tier.model} | ${tier.match.join(", ")} |`);
  const variantRows = plan.variants.map((variant) => `| ${variant.id} | ${variant.model} |`);

  return [
    `# Model Generation Handoff ${plan.batchId}`,
    "",
    "## Current Tiers",
    "| tier | model | match |",
    "|---|---|---|",
    ...tierRows,
    "",
    "## Recent Unknown Models",
    ...(plan.unknownModels.length > 0 ? plan.unknownModels.map((model) => `- ${model}`) : ["- none"]),
    "",
    "## Bakeoff Variants",
    "| variant | model |",
    "|---|---|",
    ...variantRows,
    "",
    "## Capacity Estimate",
    `- tasks: ${plan.estimate.tasks}`,
    `- replay_runs: ${plan.estimate.replayRuns}`,
    `- judge_runs: ${plan.estimate.judgeRuns}`,
    `- total_runs: ${plan.estimate.totalRuns}`,
    `- estimated_windows: ${plan.estimate.estimatedWindows}`,
    "",
    "## Commands",
    "```bash",
    ...plan.commands,
    "```",
    "",
  ].join("\n");
}
