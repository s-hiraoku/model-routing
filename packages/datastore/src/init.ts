import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const m0Tables = ["sessions", "task_events", "requests", "shift_events", "quota_events"];
const m0Indexes = [
  "idx_task_events_created",
  "idx_task_events_category",
  "idx_requests_created",
  "idx_requests_session",
  "idx_requests_replay",
  "idx_quota_window",
];

type DrizzleJournal = {
  entries: Array<{
    when: number;
  }>;
};

function hasTable(db: Database, name: string): boolean {
  return Boolean(
    db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function hasIndex(db: Database, name: string): boolean {
  return Boolean(
    db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
  );
}

function hasLegacyM0Schema(db: Database): boolean {
  return m0Tables.every((table) => hasTable(db, table)) && m0Indexes.every((indexName) => hasIndex(db, indexName));
}

function latestMigrationTimestamp(): number {
  const journalPath = join(migrationsFolder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as DrizzleJournal;
  const latest = journal.entries.at(-1);

  if (!latest) {
    throw new Error(`No Drizzle migrations found in ${journalPath}`);
  }

  return latest.when;
}

function markLegacyM0MigrationApplied(db: Database): void {
  if (hasTable(db, "__drizzle_migrations") || !hasLegacyM0Schema(db)) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
  `);
  db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
    "legacy-m0-bootstrap",
    latestMigrationTimestamp(),
  );
}

export function initializeDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    markLegacyM0MigrationApplied(db);
    migrate(drizzle(db), { migrationsFolder });
  } finally {
    db.close();
  }
}

export function defaultDatabasePath(dataDir = Bun.env.DATA_DIR ?? "data"): string {
  return `${dataDir.replace(/\/$/, "")}/model-routing.db`;
}
