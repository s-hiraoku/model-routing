import { Database } from "bun:sqlite";

export type SessionLogRow = {
  id: string;
  cwd: string | null;
  gitRemote: string | null;
  seenAt: number;
};

export type TaskEventLogRow = {
  id: string;
  sessionId: string;
  createdAt: number;
  cwd: string;
  gitHead: string | null;
  gitDirty: boolean;
  promptText: string;
  promptHash: string;
  taskCategory: string | null;
  categorySource: string | null;
  categoryConfidence: number | null;
  selfContained: boolean | null;
};

export function upsertSession(dbPath: string, row: SessionLogRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO sessions (id, cwd, git_remote, first_seen_at, last_seen_at, request_count)
      VALUES ($id, $cwd, $gitRemote, $seenAt, $seenAt, 0)
      ON CONFLICT(id) DO UPDATE SET
        cwd = excluded.cwd,
        git_remote = excluded.git_remote,
        last_seen_at = excluded.last_seen_at
      `,
    ).run({
      $id: row.id,
      $cwd: row.cwd,
      $gitRemote: row.gitRemote,
      $seenAt: row.seenAt,
    });
  } finally {
    db.close();
  }
}

export function insertTaskEvent(dbPath: string, row: TaskEventLogRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO task_events (
        id, session_id, created_at, cwd, git_head, git_dirty, prompt_text, prompt_hash,
        task_category, category_source, category_confidence, self_contained
      ) VALUES (
        $id, $sessionId, $createdAt, $cwd, $gitHead, $gitDirty, $promptText, $promptHash,
        $taskCategory, $categorySource, $categoryConfidence, $selfContained
      )
      `,
    ).run({
      $id: row.id,
      $sessionId: row.sessionId,
      $createdAt: row.createdAt,
      $cwd: row.cwd,
      $gitHead: row.gitHead,
      $gitDirty: row.gitDirty ? 1 : 0,
      $promptText: row.promptText,
      $promptHash: row.promptHash,
      $taskCategory: row.taskCategory,
      $categorySource: row.categorySource,
      $categoryConfidence: row.categoryConfidence,
      $selfContained: row.selfContained == null ? null : row.selfContained ? 1 : 0,
    });
  } finally {
    db.close();
  }
}
