import { Database } from "bun:sqlite";

export type AuditTaskRow = {
  id: string;
  createdAt: number;
  taskCategory: string | null;
  categoryConfidence: number | null;
  selfContained: boolean | null;
  promptText: string;
};

export function listAuditTasks(dbPath: string, limit: number): AuditTaskRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<
        {
          id: string;
          created_at: number;
          task_category: string | null;
          category_confidence: number | null;
          self_contained: number | null;
          prompt_text: string;
        },
        [number]
      >(
        `
        SELECT id, created_at, task_category, category_confidence, self_contained, prompt_text
        FROM task_events
        WHERE task_category IS NOT NULL
        ORDER BY abs(random())
        LIMIT ?
        `,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        taskCategory: row.task_category,
        categoryConfidence: row.category_confidence,
        selfContained: row.self_contained == null ? null : row.self_contained === 1,
        promptText: row.prompt_text,
      }));
  } finally {
    db.close();
  }
}

export function formatAuditTasks(rows: AuditTaskRow[]): string {
  if (rows.length === 0) {
    return "No classified task_events found.";
  }

  return rows
    .map((row, index) => {
      const prompt = row.promptText.replace(/\s+/g, " ").slice(0, 220);
      return [
        `#${index + 1} ${row.id}`,
        `category=${row.taskCategory ?? "unknown"} confidence=${row.categoryConfidence ?? "n/a"} self_contained=${
          row.selfContained ?? "n/a"
        }`,
        prompt,
      ].join("\n");
    })
    .join("\n\n");
}
