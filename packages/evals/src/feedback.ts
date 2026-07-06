import {
  countPreferenceQueueItemsSince,
  insertPreferenceQueueItem,
  listReviewQueue,
  type ReviewQueueItem,
} from "@model-routing/datastore";
import { type FeedbackConfig, uuidv7 } from "@model-routing/shared";

const weekMs = 7 * 24 * 60 * 60 * 1000;

export type FeedbackStageResult = {
  candidates: number;
  activeThisWeek: number;
  inserted: number;
  budget: number;
};

function weekStart(timestamp: number): number {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return start + mondayOffset * 24 * 60 * 60 * 1000;
}

export function preferencePriority(item: ReviewQueueItem): number {
  const uncertainty = item.hasJudgeConflict ? 2 : 1;
  const verifyMismatch =
    item.candidateVerifyPassed != null &&
    item.baselineVerifyPassed != null &&
    item.candidateVerifyPassed !== item.baselineVerifyPassed
      ? 0.5
      : 0;

  return uncertainty + verifyMismatch;
}

function preferenceReason(item: ReviewQueueItem): string {
  if (item.hasJudgeConflict) {
    return "judge_conflict";
  }
  if (
    item.candidateVerifyPassed != null &&
    item.baselineVerifyPassed != null &&
    item.candidateVerifyPassed !== item.baselineVerifyPassed
  ) {
    return "verify_mismatch";
  }
  return "review_queue";
}

export function runFeedbackStage(args: {
  dbPath: string;
  batchId: string;
  config: FeedbackConfig;
  now?: number;
}): FeedbackStageResult {
  const now = args.now ?? Date.now();
  const budget = args.config.attention_budget.max_push_questions_per_week;
  const activeThisWeek = countPreferenceQueueItemsSince(args.dbPath, {
    since: weekStart(now),
    statuses: ["pending", "notified"],
  });
  const available = Math.max(0, budget - activeThisWeek);

  if (available === 0) {
    return { candidates: 0, activeThisWeek, inserted: 0, budget };
  }

  const candidates = listReviewQueue(args.dbPath, Math.max(available * 4, available));
  let inserted = 0;

  for (const candidate of candidates) {
    if (inserted >= available) {
      break;
    }

    const didInsert = insertPreferenceQueueItem(args.dbPath, {
      id: uuidv7(),
      batchId: args.batchId,
      evalTaskId: candidate.evalTaskId,
      candidateRunId: candidate.candidateRunId,
      baselineRunId: candidate.baselineRunId,
      createdAt: now,
      priority: preferencePriority(candidate),
      reason: preferenceReason(candidate),
      dueAt: now + weekMs,
    });

    if (didInsert) {
      inserted += 1;
    }
  }

  return { candidates: candidates.length, activeThisWeek, inserted, budget };
}
