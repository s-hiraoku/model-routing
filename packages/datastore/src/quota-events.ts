import { Database } from "bun:sqlite";

export type QuotaEventRow = {
  id: string;
  createdAt: number;
  kind: string;
  refId: string | null;
};

export function insertQuotaEvent(dbPath: string, row: QuotaEventRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO quota_events (id, created_at, kind, ref_id)
      VALUES ($id, $createdAt, $kind, $refId)
      `,
    ).run({
      $id: row.id,
      $createdAt: row.createdAt,
      $kind: row.kind,
      $refId: row.refId,
    });
  } finally {
    db.close();
  }
}
