import { Database } from "bun:sqlite";

export type TierProfileRow = {
  batchId: string;
  variant: string;
  taskCategory: string;
  n: number;
  winRate: number;
  wilsonLow: number;
  wilsonHigh: number;
  verifyPassRate: number | null;
  avgTurns: number | null;
  avgTotalTokens: number | null;
  avgDurationMs: number | null;
  errorRate: number;
  judgeHumanKappa: number | null;
};

function tierProfileFromRow(row: {
  batch_id: string;
  variant: string;
  task_category: string;
  n: number;
  win_rate: number;
  wilson_low: number;
  wilson_high: number;
  verify_pass_rate: number | null;
  avg_turns: number | null;
  avg_total_tokens: number | null;
  avg_duration_ms: number | null;
  error_rate: number;
  judge_human_kappa: number | null;
}): TierProfileRow {
  return {
    batchId: row.batch_id,
    variant: row.variant,
    taskCategory: row.task_category,
    n: row.n,
    winRate: row.win_rate,
    wilsonLow: row.wilson_low,
    wilsonHigh: row.wilson_high,
    verifyPassRate: row.verify_pass_rate,
    avgTurns: row.avg_turns,
    avgTotalTokens: row.avg_total_tokens,
    avgDurationMs: row.avg_duration_ms,
    errorRate: row.error_rate,
    judgeHumanKappa: row.judge_human_kappa,
  };
}

export function upsertTierProfile(dbPath: string, row: TierProfileRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO tier_profiles (
        batch_id, variant, task_category, n, win_rate, wilson_low, wilson_high,
        verify_pass_rate, avg_turns, avg_total_tokens, avg_duration_ms,
        error_rate, judge_human_kappa
      ) VALUES (
        $batchId, $variant, $taskCategory, $n, $winRate, $wilsonLow, $wilsonHigh,
        $verifyPassRate, $avgTurns, $avgTotalTokens, $avgDurationMs,
        $errorRate, $judgeHumanKappa
      )
      ON CONFLICT(batch_id, variant, task_category) DO UPDATE SET
        n = excluded.n,
        win_rate = excluded.win_rate,
        wilson_low = excluded.wilson_low,
        wilson_high = excluded.wilson_high,
        verify_pass_rate = excluded.verify_pass_rate,
        avg_turns = excluded.avg_turns,
        avg_total_tokens = excluded.avg_total_tokens,
        avg_duration_ms = excluded.avg_duration_ms,
        error_rate = excluded.error_rate,
        judge_human_kappa = excluded.judge_human_kappa
      `,
    ).run({
      $batchId: row.batchId,
      $variant: row.variant,
      $taskCategory: row.taskCategory,
      $n: row.n,
      $winRate: row.winRate,
      $wilsonLow: row.wilsonLow,
      $wilsonHigh: row.wilsonHigh,
      $verifyPassRate: row.verifyPassRate,
      $avgTurns: row.avgTurns,
      $avgTotalTokens: row.avgTotalTokens,
      $avgDurationMs: row.avgDurationMs,
      $errorRate: row.errorRate,
      $judgeHumanKappa: row.judgeHumanKappa,
    });
  } finally {
    db.close();
  }
}

export function listTierProfilesByBatch(dbPath: string, batchId: string): TierProfileRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<
        {
          batch_id: string;
          variant: string;
          task_category: string;
          n: number;
          win_rate: number;
          wilson_low: number;
          wilson_high: number;
          verify_pass_rate: number | null;
          avg_turns: number | null;
          avg_total_tokens: number | null;
          avg_duration_ms: number | null;
          error_rate: number;
          judge_human_kappa: number | null;
        },
        [string]
      >("SELECT * FROM tier_profiles WHERE batch_id = ? ORDER BY task_category, variant")
      .all(batchId)
      .map(tierProfileFromRow);
  } finally {
    db.close();
  }
}
