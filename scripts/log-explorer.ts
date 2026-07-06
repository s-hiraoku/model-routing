import { Database } from "bun:sqlite";
import { defaultDatabasePath, getGatewayStats } from "@model-routing/datastore";

type RecentRequestRow = {
  id: string;
  created_at: number;
  model_requested: string;
  model_served: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  body_path: string;
};

function limitArg(fallback: number): number {
  const raw = Bun.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }

  return parsed;
}

export function listRecentRequests(dbPath: string, limit = 20): RecentRequestRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<RecentRequestRow, [number]>(
        `
        SELECT id, created_at, model_requested, model_served, status, http_status, latency_ms, body_path
        FROM requests
        ORDER BY created_at DESC
        LIMIT ?
        `,
      )
      .all(limit);
  } finally {
    db.close();
  }
}

function printRecent(rows: RecentRequestRow[]): void {
  for (const row of rows) {
    console.info(
      [
        new Date(row.created_at).toISOString(),
        row.status,
        row.http_status ?? "-",
        `${row.model_requested}->${row.model_served}`,
        `${row.latency_ms ?? "-"}ms`,
        row.id,
        row.body_path,
      ].join("\t"),
    );
  }
}

function main(): void {
  const dbPath = Bun.env.DB_PATH ?? defaultDatabasePath();
  const command = Bun.argv[2] ?? "recent";

  if (command === "stats") {
    console.info(JSON.stringify(getGatewayStats(dbPath), null, 2));
    return;
  }

  if (command === "recent") {
    printRecent(listRecentRequests(dbPath, limitArg(20)));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  main();
}
