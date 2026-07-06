import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./init";
import { insertQuotaEvent } from "./quota-events";

describe("insertQuotaEvent", () => {
  test("inserts quota event metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-quota-"));
    const dbPath = join(dir, "model-routing.db");

    try {
      initializeDatabase(dbPath);
      insertQuotaEvent(dbPath, {
        id: "0197d239-7c00-7000-8000-000000000001",
        createdAt: 1,
        kind: "rate_limited",
        refId: "request-1",
      });

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ kind: string; ref_id: string }, []>("SELECT kind, ref_id FROM quota_events").get()).toEqual({
          kind: "rate_limited",
          ref_id: "request-1",
        });
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
