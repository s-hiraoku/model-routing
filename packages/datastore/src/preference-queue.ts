import { Database } from "bun:sqlite";

export type PreferenceQueueStatus = "pending" | "notified" | "answered" | "expired" | "skipped";

export type PreferenceQueueRow = {
  id: string;
  batchId: string;
  evalTaskId: string;
  candidateRunId: string;
  baselineRunId: string;
  createdAt: number;
  priority: number;
  reason: string;
  status: PreferenceQueueStatus;
  dueAt: number | null;
  notifiedAt: number | null;
  answeredAt: number | null;
  humanReviewId: string | null;
};

export type PreferenceQueueInsert = {
  id: string;
  batchId: string;
  evalTaskId: string;
  candidateRunId: string;
  baselineRunId: string;
  createdAt: number;
  priority: number;
  reason: string;
  status?: PreferenceQueueStatus;
  dueAt?: number | null;
};

type PreferenceQueueDbRow = {
  id: string;
  batch_id: string;
  eval_task_id: string;
  candidate_run_id: string;
  baseline_run_id: string;
  created_at: number;
  priority: number;
  reason: string;
  status: PreferenceQueueStatus;
  due_at: number | null;
  notified_at: number | null;
  answered_at: number | null;
  human_review_id: string | null;
};

function preferenceQueueFromRow(row: PreferenceQueueDbRow): PreferenceQueueRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    evalTaskId: row.eval_task_id,
    candidateRunId: row.candidate_run_id,
    baselineRunId: row.baseline_run_id,
    createdAt: row.created_at,
    priority: row.priority,
    reason: row.reason,
    status: row.status,
    dueAt: row.due_at,
    notifiedAt: row.notified_at,
    answeredAt: row.answered_at,
    humanReviewId: row.human_review_id,
  };
}

export function insertPreferenceQueueItem(dbPath: string, row: PreferenceQueueInsert): boolean {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        INSERT OR IGNORE INTO preference_queue (
          id, batch_id, eval_task_id, candidate_run_id, baseline_run_id,
          created_at, priority, reason, status, due_at
        ) VALUES (
          $id, $batchId, $evalTaskId, $candidateRunId, $baselineRunId,
          $createdAt, $priority, $reason, $status, $dueAt
        )
        `,
      )
      .run({
        $id: row.id,
        $batchId: row.batchId,
        $evalTaskId: row.evalTaskId,
        $candidateRunId: row.candidateRunId,
        $baselineRunId: row.baselineRunId,
        $createdAt: row.createdAt,
        $priority: row.priority,
        $reason: row.reason,
        $status: row.status ?? "pending",
        $dueAt: row.dueAt ?? null,
      });

    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function listPreferenceQueue(
  dbPath: string,
  args: { status?: PreferenceQueueStatus; limit?: number } = {},
): PreferenceQueueRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));

    if (args.status) {
      return db
        .query<PreferenceQueueDbRow, [PreferenceQueueStatus, number]>(
          "SELECT * FROM preference_queue WHERE status = ? ORDER BY priority DESC, created_at LIMIT ?",
        )
        .all(args.status, limit)
        .map(preferenceQueueFromRow);
    }

    return db
      .query<PreferenceQueueDbRow, [number]>(
        "SELECT * FROM preference_queue ORDER BY priority DESC, created_at LIMIT ?",
      )
      .all(limit)
      .map(preferenceQueueFromRow);
  } finally {
    db.close();
  }
}

export function getPreferenceQueueItem(dbPath: string, id: string): PreferenceQueueRow | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query<PreferenceQueueDbRow, [string]>("SELECT * FROM preference_queue WHERE id = ?").get(id);
    return row ? preferenceQueueFromRow(row) : null;
  } finally {
    db.close();
  }
}

export function markPreferenceQueueAnswered(
  dbPath: string,
  args: { id: string; humanReviewId: string; answeredAt: number },
): boolean {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        UPDATE preference_queue
        SET status = 'answered',
            answered_at = $answeredAt,
            human_review_id = $humanReviewId
        WHERE id = $id
          AND status IN ('pending', 'notified')
        `,
      )
      .run({
        $id: args.id,
        $answeredAt: args.answeredAt,
        $humanReviewId: args.humanReviewId,
      });
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function expirePreferenceQueueItems(dbPath: string, now: number): number {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        UPDATE preference_queue
        SET status = 'expired'
        WHERE due_at IS NOT NULL
          AND due_at < $now
          AND status IN ('pending', 'notified')
        `,
      )
      .run({ $now: now });
    return result.changes;
  } finally {
    db.close();
  }
}

export function countPreferenceQueueItemsSince(
  dbPath: string,
  args: { since: number; statuses: PreferenceQueueStatus[] },
): number {
  if (args.statuses.length === 0) {
    return 0;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const placeholders = args.statuses.map(() => "?").join(", ");
    return (
      db
        .query<{ count: number }, [number, ...PreferenceQueueStatus[]]>(
          `SELECT count(*) AS count FROM preference_queue WHERE created_at >= ? AND status IN (${placeholders})`,
        )
        .get(args.since, ...args.statuses)?.count ?? 0
    );
  } finally {
    db.close();
  }
}
