import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDatabasePath, initializeDatabase } from "./init";

describe("initializeDatabase", () => {
  test("creates M0 tables and enables WAL mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-db-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);

      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
          )
          .all()
          .map((row) => row.name);
        const indexes = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
          .all()
          .map((row) => row.name);

        expect(tables).toEqual(["quota_events", "requests", "sessions", "shift_events", "task_events"]);
        expect(indexes).toContain("idx_requests_created");
        expect(indexes).toContain("idx_task_events_created");
        expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is safe to run more than once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-db-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      initializeDatabase(dbPath);

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM __drizzle_migrations").get()?.count).toBe(
          1,
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("defaultDatabasePath", () => {
  test("uses DATA_DIR-compatible paths", () => {
    expect(defaultDatabasePath("data/")).toBe("data/model-routing.db");
    expect(defaultDatabasePath("/tmp/model-routing")).toBe("/tmp/model-routing/model-routing.db");
  });
});
