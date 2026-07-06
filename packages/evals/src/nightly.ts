import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelsConfig } from "@model-routing/shared";

export type NightlyReport = {
  since: number;
  correctionLikeTasks: number;
  unknownModels: string[];
  shiftedErrors: Array<{ reason: string; count: number }>;
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

    return {
      since,
      correctionLikeTasks: prompts.filter((row) => correctionPattern.test(row.prompt_text)).length,
      unknownModels: models,
      shiftedErrors,
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
  ].join("\n");
}

export async function runNightly(args: {
  dbPath: string;
  models: ModelsConfig;
  reportDir: string;
  now?: number;
}): Promise<{ reportPath: string; report: NightlyReport }> {
  const now = args.now ?? Date.now();
  const report = getNightlyReport({ dbPath: args.dbPath, models: args.models, now });
  const reportPath = join(args.reportDir, `nightly-${new Date(now).toISOString().slice(0, 10)}.md`);

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, formatNightlyReport(report));

  return { reportPath, report };
}
