import { Database } from "bun:sqlite";

export type ShiftEventInsert = {
  requestId: string;
  createdAt: number;
  policyVersion: string;
  taskEventId: string | null;
  decidedCategory: string | null;
  gearFrom: string;
  gearTo: string;
  reason: string;
};

export function insertShiftEvent(dbPath: string, row: ShiftEventInsert): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT OR IGNORE INTO shift_events (
        request_id, created_at, policy_version, task_event_id,
        decided_category, gear_from, gear_to, reason
      ) VALUES (
        $requestId, $createdAt, $policyVersion, $taskEventId,
        $decidedCategory, $gearFrom, $gearTo, $reason
      )
      `,
    ).run({
      $requestId: row.requestId,
      $createdAt: row.createdAt,
      $policyVersion: row.policyVersion,
      $taskEventId: row.taskEventId,
      $decidedCategory: row.decidedCategory,
      $gearFrom: row.gearFrom,
      $gearTo: row.gearTo,
      $reason: row.reason,
    });
  } finally {
    db.close();
  }
}
