import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { defaultDatabasePath } from "@model-routing/datastore";

export type PruneCandidate = {
  id: string;
  bodyPath: string;
  createdAt: number;
};

export type PruneResult = {
  candidates: number;
  deleted: number;
  dryRun: boolean;
};

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = Bun.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }

  return parsed;
}

export function listPruneCandidates(dbPath: string, cutoffMs: number): PruneCandidate[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ id: string; body_path: string; created_at: number }, [number]>(
        `
        SELECT id, body_path, created_at
        FROM requests
        WHERE created_at < ?
          AND body_path IS NOT NULL
        ORDER BY created_at ASC
        `,
      )
      .all(cutoffMs)
      .map((row) => ({
        id: row.id,
        bodyPath: row.body_path,
        createdAt: row.created_at,
      }));
  } finally {
    db.close();
  }
}

export async function pruneBodies(
  dbPath: string,
  now = Date.now(),
  keepDays = 90,
  dryRun = false,
): Promise<PruneResult> {
  const cutoffMs = now - keepDays * 24 * 60 * 60 * 1000;
  const candidates = listPruneCandidates(dbPath, cutoffMs);
  let deleted = 0;

  for (const candidate of candidates) {
    if (!dryRun) {
      await rm(candidate.bodyPath, { force: true });
    }
    deleted += 1;
  }

  return {
    candidates: candidates.length,
    deleted,
    dryRun,
  };
}

async function main(): Promise<void> {
  const dbPath = Bun.env.DB_PATH ?? defaultDatabasePath();
  const keepDays = numberArg("keep-days", 90);
  const dryRun = Bun.argv.includes("--dry-run");
  const result = await pruneBodies(dbPath, Date.now(), keepDays, dryRun);

  console.info(
    `[prune] candidates=${result.candidates} ${dryRun ? "would_delete" : "deleted"}=${result.deleted} keep_days=${keepDays}`,
  );
}

if (import.meta.main) {
  await main();
}
