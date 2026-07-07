import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FeedbackConfig, ModelsConfig } from "@model-routing/shared";
import { parse, stringify } from "yaml";

export type NightlyReport = {
  since: number;
  correctionLikeTasks: number;
  unknownModels: string[];
  shiftedErrors: Array<{ reason: string; count: number }>;
  shiftedErrorSegments: Array<{ category: string; reason: string; count: number }>;
  autoSuspends: Array<{ category: string; reason: string; count: number }>;
};

const correctionPattern = /(違う|そうじゃなく|やり直|直ってない|まだ(ダメ|駄目)|regress|wrong|not fixed|try again)/i;

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function isKnownModel(model: string, models: ModelsConfig): boolean {
  if (models.never_touch.some((pattern) => globMatch(pattern, model))) {
    return true;
  }

  return Object.values(models.tiers).some((tier) => tier.match.some((pattern) => globMatch(pattern, model)));
}

export function getNightlyReport(args: {
  dbPath: string;
  models: ModelsConfig;
  feedbackConfig?: FeedbackConfig;
  now?: number;
  windowMs?: number;
}): NightlyReport {
  const now = args.now ?? Date.now();
  const since = now - (args.windowMs ?? 24 * 60 * 60 * 1000);
  const db = new Database(args.dbPath, { readonly: true });

  try {
    const prompts = db
      .query<{ prompt_text: string }, [number]>("SELECT prompt_text FROM task_events WHERE created_at >= ?")
      .all(since);
    const models = db
      .query<{ model: string }, [number, number]>(
        `
        SELECT DISTINCT model_requested AS model FROM requests WHERE created_at >= ?
        UNION
        SELECT DISTINCT model_served AS model FROM requests WHERE created_at >= ?
        ORDER BY model
        `,
      )
      .all(since, since)
      .map((row) => row.model)
      .filter((model) => !isKnownModel(model, args.models));
    const shiftedErrors = db
      .query<{ reason: string; count: number }, [number]>(
        `
        SELECT se.reason, COUNT(*) AS count
        FROM shift_events se
        JOIN requests r ON r.id = se.request_id
        WHERE se.created_at >= ?
          AND r.status NOT IN ('ok', 'client_abort')
        GROUP BY se.reason
        ORDER BY count DESC, se.reason
        `,
      )
      .all(since);
    const shiftedErrorSegments = db
      .query<{ category: string | null; reason: string; count: number }, [number]>(
        `
        SELECT se.decided_category AS category, se.reason, COUNT(*) AS count
        FROM shift_events se
        JOIN requests r ON r.id = se.request_id
        WHERE se.created_at >= ?
          AND r.status NOT IN ('ok', 'client_abort')
          AND se.decided_category IS NOT NULL
        GROUP BY se.decided_category, se.reason
        ORDER BY count DESC, se.decided_category, se.reason
        `,
      )
      .all(since)
      .filter((row): row is { category: string; reason: string; count: number } => row.category != null);
    const minN = args.feedbackConfig?.implicit_signals.min_n ?? Number.POSITIVE_INFINITY;

    return {
      since,
      correctionLikeTasks: prompts.filter((row) => correctionPattern.test(row.prompt_text)).length,
      unknownModels: models,
      shiftedErrors,
      shiftedErrorSegments,
      autoSuspends: shiftedErrorSegments.filter((row) => row.count >= minN),
    };
  } finally {
    db.close();
  }
}

export function formatNightlyReport(report: NightlyReport): string {
  return [
    "# Nightly Model Routing Report",
    "",
    `since: ${new Date(report.since).toISOString()}`,
    `correction_like_tasks: ${report.correctionLikeTasks}`,
    "",
    "## Unknown Models",
    ...(report.unknownModels.length > 0 ? report.unknownModels.map((model) => `- ${model}`) : ["- none"]),
    "",
    "## Shifted Errors",
    ...(report.shiftedErrors.length > 0
      ? report.shiftedErrors.map((row) => `- ${row.reason}: ${row.count}`)
      : ["- none"]),
    "",
    "## Auto Suspends",
    ...(report.autoSuspends.length > 0
      ? report.autoSuspends.map((row) => `- ${row.category}: ${row.reason} errors=${row.count}`)
      : ["- none"]),
    "",
  ].join("\n");
}

async function applyAutoSuspends(args: {
  report: NightlyReport;
  policyPath: string;
  policyOut: string;
  changelogPath: string;
  now: number;
}): Promise<{ policyPath: string; changelogPath: string; changes: number } | null> {
  if (args.report.autoSuspends.length === 0) {
    return null;
  }

  const parsedPolicy = parse(await readFile(args.policyPath, "utf8")) as Record<string, unknown>;
  const overrides =
    parsedPolicy.overrides && typeof parsedPolicy.overrides === "object" && !Array.isArray(parsedPolicy.overrides)
      ? (parsedPolicy.overrides as Record<string, unknown>)
      : {};
  const changes = args.report.autoSuspends.map((row) => {
    overrides[row.category] = {
      action: "none",
      note: `auto_rollback:${row.reason}:errors=${row.count}`,
    };
    return row;
  });

  parsedPolicy.overrides = overrides;
  parsedPolicy.version = `${typeof parsedPolicy.version === "string" ? parsedPolicy.version : "policy"}.auto-${new Date(
    args.now,
  )
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14)}`;
  parsedPolicy.generated_at = new Date(args.now).toISOString();

  await mkdir(dirname(args.policyOut), { recursive: true });
  await mkdir(dirname(args.changelogPath), { recursive: true });
  await writeFile(args.policyOut, stringify(parsedPolicy));
  await writeFile(
    args.changelogPath,
    `${JSON.stringify(
      {
        policy_version: parsedPolicy.version,
        origin: "auto_rollback",
        applied_at: new Date(args.now).toISOString(),
        changes,
      },
      null,
      2,
    )}\n`,
  );

  return { policyPath: args.policyOut, changelogPath: args.changelogPath, changes: changes.length };
}

export async function runNightly(args: {
  dbPath: string;
  models: ModelsConfig;
  feedbackConfig?: FeedbackConfig;
  reportDir: string;
  policyPath?: string;
  policyOut?: string;
  now?: number;
}): Promise<{
  reportPath: string;
  report: NightlyReport;
  autoSuspend?: { policyPath: string; changelogPath: string; changes: number } | null;
}> {
  const now = args.now ?? Date.now();
  const report = getNightlyReport({
    dbPath: args.dbPath,
    models: args.models,
    feedbackConfig: args.feedbackConfig,
    now,
  });
  const reportPath = join(args.reportDir, `nightly-${new Date(now).toISOString().slice(0, 10)}.md`);

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, formatNightlyReport(report));
  const autoSuspend =
    args.policyPath && args.feedbackConfig
      ? await applyAutoSuspends({
          report,
          policyPath: args.policyPath,
          policyOut: args.policyOut ?? args.policyPath,
          changelogPath: join(args.reportDir, `nightly-${new Date(now).toISOString().slice(0, 10)}-auto-rollback.json`),
          now,
        })
      : null;

  return { reportPath, report, autoSuspend };
}
