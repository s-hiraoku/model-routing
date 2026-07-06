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

export type ClassificationCandidateRow = {
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

export type TaskClassificationUpdate = {
  id: string;
  taskCategory: string;
  categorySource: string;
  categoryConfidence: number;
  selfContained: boolean;
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

export function listTaskEventsForClassification(dbPath: string, limit: number): ClassificationCandidateRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<
        {
          id: string;
          session_id: string;
          created_at: number;
          cwd: string;
          git_head: string | null;
          git_dirty: number;
          prompt_text: string;
          prompt_hash: string;
          task_category: string | null;
          category_source: string | null;
          category_confidence: number | null;
          self_contained: number | null;
        },
        [number]
      >(
        `
        SELECT
          id, session_id, created_at, cwd, git_head, git_dirty, prompt_text, prompt_hash,
          task_category, category_source, category_confidence, self_contained
        FROM task_events
        WHERE task_category IS NULL
           OR task_category = 'unknown'
           OR category_confidence IS NULL
           OR category_confidence < 0.8
           OR self_contained IS NULL
        ORDER BY created_at DESC
        LIMIT ?
        `,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        createdAt: row.created_at,
        cwd: row.cwd,
        gitHead: row.git_head,
        gitDirty: row.git_dirty === 1,
        promptText: row.prompt_text,
        promptHash: row.prompt_hash,
        taskCategory: row.task_category,
        categorySource: row.category_source,
        categoryConfidence: row.category_confidence,
        selfContained: row.self_contained == null ? null : row.self_contained === 1,
      }));
  } finally {
    db.close();
  }
}

export function updateTaskClassification(dbPath: string, row: TaskClassificationUpdate): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      UPDATE task_events
      SET task_category = $taskCategory,
          category_source = $categorySource,
          category_confidence = $categoryConfidence,
          self_contained = $selfContained
      WHERE id = $id
      `,
    ).run({
      $id: row.id,
      $taskCategory: row.taskCategory,
      $categorySource: row.categorySource,
      $categoryConfidence: row.categoryConfidence,
      $selfContained: row.selfContained ? 1 : 0,
    });
  } finally {
    db.close();
  }
}
