import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const schemaSql = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  cwd           TEXT,
  git_remote    TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  created_at    INTEGER NOT NULL,
  cwd           TEXT NOT NULL,
  git_head      TEXT,
  git_dirty     INTEGER NOT NULL,
  prompt_text   TEXT NOT NULL,
  prompt_hash   TEXT NOT NULL,
  task_category TEXT,
  category_source TEXT,
  category_confidence REAL,
  self_contained  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_events_created ON task_events(created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_category ON task_events(task_category, created_at);

CREATE TABLE IF NOT EXISTS requests (
  id               TEXT PRIMARY KEY,
  session_id       TEXT REFERENCES sessions(id),
  replay_run_id    TEXT,
  created_at       INTEGER NOT NULL,
  model_requested  TEXT NOT NULL,
  model_served     TEXT NOT NULL,
  is_streaming     INTEGER NOT NULL,
  message_count    INTEGER NOT NULL,
  tool_count       INTEGER NOT NULL,
  has_tool_results INTEGER NOT NULL,
  has_images       INTEGER NOT NULL,
  system_hash      TEXT,
  prompt_hash      TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  status           TEXT NOT NULL,
  http_status      INTEGER,
  stop_reason      TEXT,
  latency_ms       INTEGER,
  ttft_ms          INTEGER,
  error_message    TEXT,
  body_path        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_replay ON requests(replay_run_id);

CREATE TABLE IF NOT EXISTS shift_events (
  request_id      TEXT PRIMARY KEY REFERENCES requests(id),
  created_at      INTEGER NOT NULL,
  policy_version  TEXT NOT NULL,
  task_event_id   TEXT REFERENCES task_events(id),
  decided_category TEXT,
  gear_from       TEXT NOT NULL,
  gear_to         TEXT NOT NULL,
  reason          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_events (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  ref_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_quota_window ON quota_events(created_at);
`;

export function initializeDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(schemaSql);
  } finally {
    db.close();
  }
}

export function defaultDatabasePath(dataDir = Bun.env.DATA_DIR ?? "data"): string {
  return `${dataDir.replace(/\/$/, "")}/model-routing.db`;
}
