import { readFile } from "node:fs/promises";
import { defaultDatabasePath, initializeDatabase, listEvalTasksByBatch } from "@model-routing/datastore";
import { loadEvalConfig, loadFeedbackConfig, loadModelsConfig } from "@model-routing/shared";
import { runAggregateStage } from "./aggregate";
import { formatAuditTasks, listAuditTasks } from "./audit";
import { classifyTasks, createAgentSdkClassifier, lowTierModel } from "./classify";
import { runFeedbackStage } from "./feedback";
import { runJudgeStage } from "./judge";
import { runNightly } from "./nightly";
import { runReportStage } from "./policy";
import { runReplayStage } from "./replay";
import { formatM1Report, getM1Report } from "./report";
import { estimateRuns, sampleTasks } from "./sample";
import { assertAllowedHour } from "./schedule";
import { runAgentSdkSmoke } from "./smoke";

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

function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags.get(name);
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }

  return parsed;
}

function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run evals -- run --batch <id> --stage classify|sample|replay|judge|aggregate|report|feedback|all [--llm] [--yes]",
    "  bun run evals -- estimate --batch <id>",
    "  bun run evals -- audit-classify --n 50",
    "  bun run evals -- nightly",
    "  bun run evals -- report",
    "  bun run smoke",
  ].join("\n");
}

async function commandRun(args: ParsedArgs): Promise<void> {
  const stage = flagString(args, "stage", "all");
  const batchId = flagString(args, "batch", "");
  if (!batchId) {
    throw new Error("--batch is required");
  }

  const dbPath = flagString(args, "db", defaultDatabasePath());
  const config = await loadEvalConfig(flagString(args, "config", "config/eval.yaml"));
  const models = await loadModelsConfig(flagString(args, "models", "config/models.yaml"));
  initializeDatabase(dbPath);

  if (flagBoolean(args, "respect-schedule")) {
    assertAllowedHour(new Date(), config.schedule.allowed_hours);
  }

  if (stage === "classify" || stage === "all") {
    const limit = flagNumber(args, "limit", 100);
    const llmClassifier = flagBoolean(args, "llm")
      ? await createAgentSdkClassifier({
          model: lowTierModel(models),
          gatewayBaseUrl: flagString(args, "gateway", ""),
          promptTemplate: await readFile(flagString(args, "prompt", "config/prompts/classify-v1.md"), "utf8"),
        })
      : undefined;
    const result = await classifyTasks({ dbPath, limit, llmClassifier });
    console.info(
      `classify: scanned=${result.scanned} updated=${result.updated} llm_used=${result.llmUsed}${
        llmClassifier ? "" : " (heuristic-only; pass --llm to classify unknown/low-confidence tasks)"
      }`,
    );
  }

  if (stage === "sample" || stage === "all") {
    const result = sampleTasks({
      dbPath,
      batchId,
      config,
      evalRunsPerWindow: models.subscription.eval_runs_per_window,
      dryRun: !flagBoolean(args, "yes"),
    });

    if (!flagBoolean(args, "yes")) {
      console.info("sample: dry run; pass --yes to insert eval_tasks.");
    }

    console.info(
      `sample: inserted=${result.inserted} existing=${result.alreadyPresent} tasks=${result.estimate.tasks} total_runs=${result.estimate.totalRuns} estimated_windows=${result.estimate.estimatedWindows}`,
    );
  }

  if (stage === "replay" || stage === "all") {
    const result = await runReplayStage({
      dbPath,
      batchId,
      config,
      models,
      dataDir: flagString(args, "data-dir", Bun.env.DATA_DIR ?? "data"),
      gatewayBaseUrl: flagString(args, "gateway", ""),
    });
    console.info(`replay: tasks=${result.tasks} inserted=${result.insertedRuns} skipped=${result.skippedRuns}`);
  }

  if (stage === "judge" || stage === "all") {
    const result = await runJudgeStage({
      dbPath,
      batchId,
      config,
      models,
      promptPath: flagString(args, "judge-prompt", "config/prompts/pairwise-v1.md"),
      gatewayBaseUrl: flagString(args, "gateway", ""),
    });
    console.info(
      `judge: tasks=${result.tasks} inserted=${result.insertedJudgments} skipped=${result.skippedJudgments} missing_baselines=${result.missingBaselines}`,
    );
  }

  if (stage === "aggregate" || stage === "all") {
    const result = runAggregateStage({ dbPath, batchId, config });
    console.info(`aggregate: profiles=${result.profiles}`);
  }

  if (stage === "report" || stage === "all") {
    const policyOut = flagString(args, "policy-out", `data/policies/shift-policy-${batchId}.yaml`);
    const result = await runReportStage({
      dbPath,
      batchId,
      config,
      reportDir: flagString(args, "report-dir", "data/reports"),
      policyOut,
      existingPolicyPath: flagString(args, "existing-policy", ""),
    });
    console.info(
      `report: profiles=${result.profiles} report=${result.reportPath} policy=${result.policyPath} changelog=${result.changelogPath}`,
    );
  }

  if (stage === "feedback" || stage === "all") {
    const feedbackConfig = await loadFeedbackConfig(flagString(args, "feedback-config", "config/feedback.yaml"));
    const result = runFeedbackStage({ dbPath, batchId, config: feedbackConfig });
    console.info(
      `feedback: candidates=${result.candidates} inserted=${result.inserted} expired=${result.expired} notes_parsed=${result.notesParsed} proposals=${result.proposalsInserted} active_this_week=${result.activeThisWeek} budget=${result.budget}`,
    );
  }

  if (stage === "all") {
    console.info(formatM1Report(getM1Report(dbPath)));
  }
}

async function commandEstimate(args: ParsedArgs): Promise<void> {
  const batchId = flagString(args, "batch", "");
  if (!batchId) {
    throw new Error("--batch is required");
  }

  const dbPath = flagString(args, "db", defaultDatabasePath());
  const config = await loadEvalConfig(flagString(args, "config", "config/eval.yaml"));
  const models = await loadModelsConfig(flagString(args, "models", "config/models.yaml"));
  initializeDatabase(dbPath);
  const existing = listEvalTasksByBatch(dbPath, batchId).length;
  const taskCount = existing || config.sampling.per_batch;
  const estimate = estimateRuns(taskCount, config.replay.variants.length, models.subscription.eval_runs_per_window);

  console.info(
    `estimate: tasks=${estimate.tasks} replay_runs=${estimate.replayRuns} judge_runs=${estimate.judgeRuns} total_runs=${estimate.totalRuns} estimated_windows=${estimate.estimatedWindows}`,
  );
}

async function commandAuditClassify(args: ParsedArgs): Promise<void> {
  const dbPath = flagString(args, "db", defaultDatabasePath());
  const n = flagNumber(args, "n", 50);
  initializeDatabase(dbPath);
  console.info(formatAuditTasks(listAuditTasks(dbPath, n)));
}

async function commandReport(args: ParsedArgs): Promise<void> {
  const dbPath = flagString(args, "db", defaultDatabasePath());
  initializeDatabase(dbPath);
  console.info(formatM1Report(getM1Report(dbPath)));
}

async function commandNightly(args: ParsedArgs): Promise<void> {
  const dbPath = flagString(args, "db", defaultDatabasePath());
  const models = await loadModelsConfig(flagString(args, "models", "config/models.yaml"));
  const feedbackConfig = await loadFeedbackConfig(flagString(args, "feedback-config", "config/feedback.yaml"));
  const policyPath = flagString(args, "policy", "");
  initializeDatabase(dbPath);
  const result = await runNightly({
    dbPath,
    models,
    feedbackConfig,
    reportDir: flagString(args, "report-dir", "data/reports"),
    policyPath: policyPath || undefined,
    policyOut: flagString(args, "policy-out", policyPath),
  });

  console.info(
    `nightly: report=${result.reportPath}${
      result.autoSuspend ? ` auto_suspend=${result.autoSuspend.changes} policy=${result.autoSuspend.policyPath}` : ""
    }`,
  );
}

async function commandSmoke(args: ParsedArgs): Promise<void> {
  const models = await loadModelsConfig(flagString(args, "models", "config/models.yaml"));
  const result = await runAgentSdkSmoke({
    model: flagString(args, "model", models.tiers.low.model),
    gatewayBaseUrl: flagString(args, "gateway", ""),
    cwd: flagString(args, "cwd", process.cwd()),
  });

  console.info(`smoke: ${result}`);
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "run":
      await commandRun(args);
      return;
    case "estimate":
      await commandEstimate(args);
      return;
    case "audit-classify":
      await commandAuditClassify(args);
      return;
    case "nightly":
      await commandNightly(args);
      return;
    case "report":
      await commandReport(args);
      return;
    case "smoke":
      await commandSmoke(args);
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
