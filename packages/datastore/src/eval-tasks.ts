import { Database } from "bun:sqlite";

export type EvalTaskRow = {
  id: string;
  taskEventId: string;
  batchId: string;
  createdAt: number;
  taskCategory: string;
  repoPath: string;
  baseCommit: string;
  promptText: string;
  verifyCommand: string | null;
  status: string;
};

export type EvalTaskInsert = Omit<EvalTaskRow, "status"> & {
  status?: string;
};

export type SampleCandidateRow = {
  taskEventId: string;
  createdAt: number;
  taskCategory: string;
  repoPath: string;
  baseCommit: string;
  promptText: string;
  promptHash: string;
  sessionId: string;
};

function evalTaskFromRow(row: {
  id: string;
  task_event_id: string;
  batch_id: string;
  created_at: number;
  task_category: string;
  repo_path: string;
  base_commit: string;
  prompt_text: string;
  verify_command: string | null;
  status: string;
}): EvalTaskRow {
  return {
    id: row.id,
    taskEventId: row.task_event_id,
    batchId: row.batch_id,
    createdAt: row.created_at,
    taskCategory: row.task_category,
    repoPath: row.repo_path,
    baseCommit: row.base_commit,
    promptText: row.prompt_text,
    verifyCommand: row.verify_command,
    status: row.status,
  };
}

export function insertEvalTask(dbPath: string, row: EvalTaskInsert): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT OR IGNORE INTO eval_tasks (
        id, task_event_id, batch_id, created_at, task_category, repo_path,
        base_commit, prompt_text, verify_command, status
      ) VALUES (
        $id, $taskEventId, $batchId, $createdAt, $taskCategory, $repoPath,
        $baseCommit, $promptText, $verifyCommand, $status
      )
      `,
    ).run({
      $id: row.id,
      $taskEventId: row.taskEventId,
      $batchId: row.batchId,
      $createdAt: row.createdAt,
      $taskCategory: row.taskCategory,
      $repoPath: row.repoPath,
      $baseCommit: row.baseCommit,
      $promptText: row.promptText,
      $verifyCommand: row.verifyCommand,
      $status: row.status ?? "pending",
    });
  } finally {
    db.close();
  }
}

export function listEvalTasksByBatch(dbPath: string, batchId: string): EvalTaskRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<
        {
          id: string;
          task_event_id: string;
          batch_id: string;
          created_at: number;
          task_category: string;
          repo_path: string;
          base_commit: string;
          prompt_text: string;
          verify_command: string | null;
          status: string;
        },
        [string]
      >("SELECT * FROM eval_tasks WHERE batch_id = ? ORDER BY created_at, id")
      .all(batchId)
      .map(evalTaskFromRow);
  } finally {
    db.close();
  }
}

export function countEvalTasksByBatch(dbPath: string, batchId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM eval_tasks WHERE batch_id = ?").get(batchId)
        ?.count ?? 0
    );
  } finally {
    db.close();
  }
}

export function listSampleCandidates(
  dbPath: string,
  args: {
    since: number;
    excludeRepos: string[];
    limit: number;
  },
): SampleCandidateRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query<
        {
          task_event_id: string;
          created_at: number;
          task_category: string;
          repo_path: string;
          base_commit: string;
          prompt_text: string;
          prompt_hash: string;
          session_id: string;
        },
        [number, number]
      >(
        `
        SELECT
          te.id AS task_event_id,
          te.created_at,
          te.task_category,
          te.cwd AS repo_path,
          te.git_head AS base_commit,
          te.prompt_text,
          te.prompt_hash,
          te.session_id
        FROM task_events te
        WHERE te.created_at >= ?
          AND te.task_category IS NOT NULL
          AND te.task_category != 'unknown'
          AND te.self_contained = 1
          AND te.git_head IS NOT NULL
          AND te.git_dirty = 0
          AND NOT EXISTS (
            SELECT 1
            FROM eval_tasks et
            JOIN task_events used ON used.id = et.task_event_id
            WHERE used.prompt_hash = te.prompt_hash
          )
        ORDER BY te.created_at DESC
        LIMIT ?
        `,
      )
      .all(args.since, args.limit * 3)
      .filter((row) => !args.excludeRepos.includes(row.repo_path));

    const seenPromptHashes = new Set<string>();
    const seenSessionCounts = new Map<string, number>();
    const candidates: SampleCandidateRow[] = [];

    for (const row of rows) {
      if (seenPromptHashes.has(row.prompt_hash)) {
        continue;
      }

      const sessionCount = seenSessionCounts.get(row.session_id) ?? 0;
      if (sessionCount >= 2) {
        continue;
      }

      seenPromptHashes.add(row.prompt_hash);
      seenSessionCounts.set(row.session_id, sessionCount + 1);
      candidates.push({
        taskEventId: row.task_event_id,
        createdAt: row.created_at,
        taskCategory: row.task_category,
        repoPath: row.repo_path,
        baseCommit: row.base_commit,
        promptText: row.prompt_text,
        promptHash: row.prompt_hash,
        sessionId: row.session_id,
      });

      if (candidates.length >= args.limit) {
        break;
      }
    }

    return candidates;
  } finally {
    db.close();
  }
}
