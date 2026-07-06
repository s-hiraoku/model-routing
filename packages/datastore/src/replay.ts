import { Database } from "bun:sqlite";

export type ReplayRunRow = {
  id: string;
  evalTaskId: string;
  variant: string;
  createdAt: number;
  status: string;
  durationMs: number | null;
  turns: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheRead: number | null;
  diffPath: string | null;
  diffStat: string | null;
  finalMessagePath: string | null;
  verifyPassed: boolean | null;
  errorMessage: string | null;
};

export type ReplayRunInsert = Omit<ReplayRunRow, "verifyPassed"> & {
  verifyPassed: boolean | null;
};

export type JudgmentRow = {
  id: string;
  evalTaskId: string;
  candidateRunId: string;
  baselineRunId: string;
  position: string;
  promptVersion: string;
  createdAt: number;
  verdict: string;
  scoresJson: string | null;
  rationale: string | null;
};

export type HumanReviewRow = {
  id: string;
  evalTaskId: string;
  candidateRunId: string;
  baselineRunId: string;
  createdAt: number;
  source: string;
  verdict: string;
  note: string | null;
  reviewSeconds: number | null;
};

function replayRunFromRow(row: {
  id: string;
  eval_task_id: string;
  variant: string;
  created_at: number;
  status: string;
  duration_ms: number | null;
  turns: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cache_read: number | null;
  diff_path: string | null;
  diff_stat: string | null;
  final_message_path: string | null;
  verify_passed: number | null;
  error_message: string | null;
}): ReplayRunRow {
  return {
    id: row.id,
    evalTaskId: row.eval_task_id,
    variant: row.variant,
    createdAt: row.created_at,
    status: row.status,
    durationMs: row.duration_ms,
    turns: row.turns,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCacheRead: row.total_cache_read,
    diffPath: row.diff_path,
    diffStat: row.diff_stat,
    finalMessagePath: row.final_message_path,
    verifyPassed: row.verify_passed == null ? null : row.verify_passed === 1,
    errorMessage: row.error_message,
  };
}

export function insertReplayRun(dbPath: string, row: ReplayRunInsert): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT OR IGNORE INTO replay_runs (
        id, eval_task_id, variant, created_at, status, duration_ms, turns,
        total_input_tokens, total_output_tokens, total_cache_read, diff_path,
        diff_stat, final_message_path, verify_passed, error_message
      ) VALUES (
        $id, $evalTaskId, $variant, $createdAt, $status, $durationMs, $turns,
        $totalInputTokens, $totalOutputTokens, $totalCacheRead, $diffPath,
        $diffStat, $finalMessagePath, $verifyPassed, $errorMessage
      )
      `,
    ).run({
      $id: row.id,
      $evalTaskId: row.evalTaskId,
      $variant: row.variant,
      $createdAt: row.createdAt,
      $status: row.status,
      $durationMs: row.durationMs,
      $turns: row.turns,
      $totalInputTokens: row.totalInputTokens,
      $totalOutputTokens: row.totalOutputTokens,
      $totalCacheRead: row.totalCacheRead,
      $diffPath: row.diffPath,
      $diffStat: row.diffStat,
      $finalMessagePath: row.finalMessagePath,
      $verifyPassed: row.verifyPassed == null ? null : row.verifyPassed ? 1 : 0,
      $errorMessage: row.errorMessage,
    });
  } finally {
    db.close();
  }
}

export function listReplayRunsForTask(dbPath: string, evalTaskId: string): ReplayRunRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<
        {
          id: string;
          eval_task_id: string;
          variant: string;
          created_at: number;
          status: string;
          duration_ms: number | null;
          turns: number | null;
          total_input_tokens: number | null;
          total_output_tokens: number | null;
          total_cache_read: number | null;
          diff_path: string | null;
          diff_stat: string | null;
          final_message_path: string | null;
          verify_passed: number | null;
          error_message: string | null;
        },
        [string]
      >("SELECT * FROM replay_runs WHERE eval_task_id = ? ORDER BY variant")
      .all(evalTaskId)
      .map(replayRunFromRow);
  } finally {
    db.close();
  }
}

export function insertJudgment(dbPath: string, row: JudgmentRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT OR IGNORE INTO judgments (
        id, eval_task_id, candidate_run_id, baseline_run_id, position,
        prompt_version, created_at, verdict, scores_json, rationale
      ) VALUES (
        $id, $evalTaskId, $candidateRunId, $baselineRunId, $position,
        $promptVersion, $createdAt, $verdict, $scoresJson, $rationale
      )
      `,
    ).run({
      $id: row.id,
      $evalTaskId: row.evalTaskId,
      $candidateRunId: row.candidateRunId,
      $baselineRunId: row.baselineRunId,
      $position: row.position,
      $promptVersion: row.promptVersion,
      $createdAt: row.createdAt,
      $verdict: row.verdict,
      $scoresJson: row.scoresJson,
      $rationale: row.rationale,
    });
  } finally {
    db.close();
  }
}

export function insertHumanReview(dbPath: string, row: HumanReviewRow): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO human_reviews (
        id, eval_task_id, candidate_run_id, baseline_run_id, created_at,
        source, verdict, note, review_seconds
      ) VALUES (
        $id, $evalTaskId, $candidateRunId, $baselineRunId, $createdAt,
        $source, $verdict, $note, $reviewSeconds
      )
      `,
    ).run({
      $id: row.id,
      $evalTaskId: row.evalTaskId,
      $candidateRunId: row.candidateRunId,
      $baselineRunId: row.baselineRunId,
      $createdAt: row.createdAt,
      $source: row.source,
      $verdict: row.verdict,
      $note: row.note,
      $reviewSeconds: row.reviewSeconds,
    });
  } finally {
    db.close();
  }
}
