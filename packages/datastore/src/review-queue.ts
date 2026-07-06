import { Database } from "bun:sqlite";

export type ReviewQueueItem = {
  evalTaskId: string;
  taskCategory: string;
  promptText: string;
  repoPath: string;
  baseCommit: string;
  candidateRunId: string;
  candidateVariant: string;
  candidateDiffPath: string | null;
  candidateDiffStat: string | null;
  candidateFinalMessagePath: string | null;
  candidateVerifyPassed: boolean | null;
  baselineRunId: string;
  baselineVariant: string;
  baselineDiffPath: string | null;
  baselineDiffStat: string | null;
  baselineFinalMessagePath: string | null;
  baselineVerifyPassed: boolean | null;
  judgmentSummary: string;
  hasJudgeConflict: boolean;
};

type ReviewQueueRow = {
  eval_task_id: string;
  task_category: string;
  prompt_text: string;
  repo_path: string;
  base_commit: string;
  candidate_run_id: string;
  candidate_variant: string;
  candidate_diff_path: string | null;
  candidate_diff_stat: string | null;
  candidate_final_message_path: string | null;
  candidate_verify_passed: number | null;
  baseline_run_id: string;
  baseline_variant: string;
  baseline_diff_path: string | null;
  baseline_diff_stat: string | null;
  baseline_final_message_path: string | null;
  baseline_verify_passed: number | null;
  judgment_summary: string | null;
  distinct_verdicts: number;
};

function nullableBool(value: number | null): boolean | null {
  if (value == null) {
    return null;
  }

  return value === 1;
}

function queueItemFromRow(row: ReviewQueueRow): ReviewQueueItem {
  return {
    evalTaskId: row.eval_task_id,
    taskCategory: row.task_category,
    promptText: row.prompt_text,
    repoPath: row.repo_path,
    baseCommit: row.base_commit,
    candidateRunId: row.candidate_run_id,
    candidateVariant: row.candidate_variant,
    candidateDiffPath: row.candidate_diff_path,
    candidateDiffStat: row.candidate_diff_stat,
    candidateFinalMessagePath: row.candidate_final_message_path,
    candidateVerifyPassed: nullableBool(row.candidate_verify_passed),
    baselineRunId: row.baseline_run_id,
    baselineVariant: row.baseline_variant,
    baselineDiffPath: row.baseline_diff_path,
    baselineDiffStat: row.baseline_diff_stat,
    baselineFinalMessagePath: row.baseline_final_message_path,
    baselineVerifyPassed: nullableBool(row.baseline_verify_passed),
    judgmentSummary: row.judgment_summary ?? "",
    hasJudgeConflict: row.distinct_verdicts > 1,
  };
}

const reviewQueueSelect = `
  SELECT
    et.id AS eval_task_id,
    et.task_category,
    et.prompt_text,
    et.repo_path,
    et.base_commit,
    candidate.id AS candidate_run_id,
    candidate.variant AS candidate_variant,
    candidate.diff_path AS candidate_diff_path,
    candidate.diff_stat AS candidate_diff_stat,
    candidate.final_message_path AS candidate_final_message_path,
    candidate.verify_passed AS candidate_verify_passed,
    baseline.id AS baseline_run_id,
    baseline.variant AS baseline_variant,
    baseline.diff_path AS baseline_diff_path,
    baseline.diff_stat AS baseline_diff_stat,
    baseline.final_message_path AS baseline_final_message_path,
    baseline.verify_passed AS baseline_verify_passed,
    GROUP_CONCAT(j.position || '=' || j.verdict, ', ') AS judgment_summary,
    COUNT(DISTINCT j.verdict) AS distinct_verdicts,
    MIN(j.created_at) AS first_judged_at
  FROM judgments j
  JOIN eval_tasks et ON et.id = j.eval_task_id
  JOIN replay_runs candidate ON candidate.id = j.candidate_run_id
  JOIN replay_runs baseline ON baseline.id = j.baseline_run_id
  LEFT JOIN human_reviews hr
    ON hr.eval_task_id = j.eval_task_id
   AND hr.candidate_run_id = j.candidate_run_id
   AND hr.baseline_run_id = j.baseline_run_id
`;

export function listReviewQueue(dbPath: string, limit: number): ReviewQueueItem[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<ReviewQueueRow, [number]>(
        `
        ${reviewQueueSelect}
        WHERE hr.id IS NULL
        GROUP BY j.eval_task_id, j.candidate_run_id, j.baseline_run_id
        ORDER BY distinct_verdicts DESC, first_judged_at, j.eval_task_id
        LIMIT ?
        `,
      )
      .all(limit)
      .map(queueItemFromRow);
  } finally {
    db.close();
  }
}

export function getReviewQueueItem(
  dbPath: string,
  args: { evalTaskId: string; candidateRunId: string; baselineRunId: string },
): ReviewQueueItem | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<ReviewQueueRow, [string, string, string]>(
        `
        ${reviewQueueSelect}
        WHERE j.eval_task_id = ?
          AND j.candidate_run_id = ?
          AND j.baseline_run_id = ?
        GROUP BY j.eval_task_id, j.candidate_run_id, j.baseline_run_id
        LIMIT 1
        `,
      )
      .get(args.evalTaskId, args.candidateRunId, args.baselineRunId);

    return row ? queueItemFromRow(row) : null;
  } finally {
    db.close();
  }
}
