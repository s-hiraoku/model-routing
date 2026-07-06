import { Database } from "bun:sqlite";

export type GatewayStats = {
  windowMs: number;
  requests: {
    total: number;
    byStatus: Record<string, number>;
  };
  cache: {
    inputTokens: number;
    cacheReadTokens: number;
    hitRate: number | null;
  };
  models: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
    }
  >;
  shifts: {
    byReason: Record<string, number>;
    byGear: Record<string, number>;
  };
};

type CountRow = {
  key: string | null;
  count: number;
};

type ModelRow = {
  model: string;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

type CacheRow = {
  inputTokens: number | null;
  cacheReadTokens: number | null;
};

function countRowsToRecord(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key ?? "unknown", row.count]));
}

export function getGatewayStats(dbPath: string, now = Date.now(), windowMs = 24 * 60 * 60 * 1000): GatewayStats {
  const since = now - windowMs;
  const db = new Database(dbPath, { readonly: true });

  try {
    const total =
      db.query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM requests WHERE created_at >= ?").get(since)
        ?.count ?? 0;
    const byStatus = countRowsToRecord(
      db
        .query<CountRow, [number]>(
          "SELECT status AS key, COUNT(*) AS count FROM requests WHERE created_at >= ? GROUP BY status ORDER BY status",
        )
        .all(since),
    );
    const cache = db
      .query<CacheRow, [number]>(
        `
        SELECT
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
        FROM requests
        WHERE created_at >= ?
        `,
      )
      .get(since) ?? { inputTokens: 0, cacheReadTokens: 0 };
    const modelRows = db
      .query<ModelRow, [number]>(
        `
        SELECT
          model_served AS model,
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens
        FROM requests
        WHERE created_at >= ?
        GROUP BY model_served
        ORDER BY model_served
        `,
      )
      .all(since);
    const byReason = countRowsToRecord(
      db
        .query<CountRow, [number]>(
          "SELECT reason AS key, COUNT(*) AS count FROM shift_events WHERE created_at >= ? GROUP BY reason ORDER BY reason",
        )
        .all(since),
    );
    const byGear = countRowsToRecord(
      db
        .query<CountRow, [number]>(
          `
          SELECT gear_from || '->' || gear_to AS key, COUNT(*) AS count
          FROM shift_events
          WHERE created_at >= ?
          GROUP BY gear_from, gear_to
          ORDER BY gear_from, gear_to
          `,
        )
        .all(since),
    );

    const inputTokens = cache.inputTokens ?? 0;
    const cacheReadTokens = cache.cacheReadTokens ?? 0;
    const cacheDenominator = inputTokens + cacheReadTokens;

    return {
      windowMs,
      requests: {
        total,
        byStatus,
      },
      cache: {
        inputTokens,
        cacheReadTokens,
        hitRate: cacheDenominator ? cacheReadTokens / cacheDenominator : null,
      },
      models: Object.fromEntries(
        modelRows.map((row) => [
          row.model,
          {
            requests: row.requests,
            inputTokens: row.inputTokens ?? 0,
            outputTokens: row.outputTokens ?? 0,
          },
        ]),
      ),
      shifts: {
        byReason,
        byGear,
      },
    };
  } finally {
    db.close();
  }
}
