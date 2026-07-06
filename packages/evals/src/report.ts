import { Database } from "bun:sqlite";

export type CategoryDistributionRow = {
  taskCategory: string;
  count: number;
};

export type M1Report = {
  totalTaskEvents: number;
  unknownTaskEvents: number;
  unknownRate: number;
  dirtyTaskEvents: number;
  dirtyRate: number;
  selfContainedTaskEvents: number;
  selfContainedRate: number;
  reproducibleTaskEvents: number;
  categoryDistribution: CategoryDistributionRow[];
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function getM1Report(dbPath: string): M1Report {
  const db = new Database(dbPath, { readonly: true });
  try {
    const totalTaskEvents =
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM task_events").get()?.count ?? 0;
    const unknownTaskEvents =
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM task_events WHERE task_category IS NULL OR task_category = 'unknown'",
        )
        .get()?.count ?? 0;
    const dirtyTaskEvents =
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM task_events WHERE git_dirty = 1").get()?.count ??
      0;
    const selfContainedTaskEvents =
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM task_events WHERE self_contained = 1").get()
        ?.count ?? 0;
    const reproducibleTaskEvents =
      db
        .query<{ count: number }, []>(
          `
          SELECT count(*) AS count
          FROM task_events
          WHERE git_dirty = 0
            AND git_head IS NOT NULL
            AND self_contained = 1
            AND task_category IS NOT NULL
            AND task_category != 'unknown'
          `,
        )
        .get()?.count ?? 0;
    const categoryDistribution = db
      .query<{ task_category: string | null; count: number }, []>(
        `
        SELECT coalesce(task_category, 'unknown') AS task_category, count(*) AS count
        FROM task_events
        GROUP BY coalesce(task_category, 'unknown')
        ORDER BY count DESC, task_category
        `,
      )
      .all()
      .map((row) => ({ taskCategory: row.task_category ?? "unknown", count: row.count }));

    return {
      totalTaskEvents,
      unknownTaskEvents,
      unknownRate: ratio(unknownTaskEvents, totalTaskEvents),
      dirtyTaskEvents,
      dirtyRate: ratio(dirtyTaskEvents, totalTaskEvents),
      selfContainedTaskEvents,
      selfContainedRate: ratio(selfContainedTaskEvents, totalTaskEvents),
      reproducibleTaskEvents,
      categoryDistribution,
    };
  } finally {
    db.close();
  }
}

export function formatM1Report(report: M1Report): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const categories = report.categoryDistribution.map((row) => `  ${row.taskCategory}: ${row.count}`).join("\n");

  return [
    `total_task_events: ${report.totalTaskEvents}`,
    `unknown: ${report.unknownTaskEvents} (${percent(report.unknownRate)})`,
    `dirty: ${report.dirtyTaskEvents} (${percent(report.dirtyRate)})`,
    `self_contained: ${report.selfContainedTaskEvents} (${percent(report.selfContainedRate)})`,
    `reproducible_candidates: ${report.reproducibleTaskEvents}`,
    "categories:",
    categories || "  (none)",
  ].join("\n");
}
