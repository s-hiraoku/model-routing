import {
  countPreferenceQueueItemsSince,
  expirePreferenceQueueItems,
  type FeedbackNoteRow,
  insertFeedbackProposal,
  insertPreferenceQueueItem,
  listFeedbackNotes,
  listReviewQueue,
  markFeedbackNoteParsed,
  type ReviewQueueItem,
} from "@model-routing/datastore";
import { classifyHeuristic, type FeedbackConfig, type TaskCategory, type Tier, uuidv7 } from "@model-routing/shared";

const weekMs = 7 * 24 * 60 * 60 * 1000;

export type FeedbackStageResult = {
  candidates: number;
  activeThisWeek: number;
  expired: number;
  inserted: number;
  notesParsed: number;
  proposalsInserted: number;
  budget: number;
};

export type FeedbackInterpretation = {
  intent: "prefer_higher" | "prefer_lower" | "hold" | "unknown";
  category: TaskCategory | null;
  desiredTier: Tier | null;
  rationale: string;
};

export type FeedbackProposal = {
  kind: "policy_override" | "evaluation_followup";
  title: string;
  summary: string;
  proposal: Record<string, unknown>;
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

function desiredTierFromText(text: string, intent: FeedbackInterpretation["intent"]): Tier | null {
  if (/(opus|high|上げ|昇格|積極的)/i.test(text)) {
    return "high";
  }
  if (/(sonnet|mid|中間|戻し|固定)/i.test(text)) {
    return "mid";
  }
  if (/(haiku|low|下げ|降格)/i.test(text)) {
    return "low";
  }
  if (intent === "prefer_higher") {
    return "high";
  }
  if (intent === "prefer_lower") {
    return "low";
  }
  return null;
}

export function interpretFeedbackNote(note: FeedbackNoteRow): FeedbackInterpretation {
  const text = note.text;
  const heuristic = classifyHeuristic(text);
  const category =
    heuristic.category === "unknown" && /(docs?|document|readme|commit message|コミットメッセージ)/i.test(text)
      ? "docs"
      : heuristic.category === "unknown"
        ? null
        : heuristic.category;
  const intent: FeedbackInterpretation["intent"] = /(上げ|昇格|もっと.*(強|高)|opus|high|積極的)/i.test(text)
    ? "prefer_higher"
    : /(下げ|降格|haiku|low|安く|軽く)/i.test(text)
      ? "prefer_lower"
      : /(固定|維持|戻し|sonnet|mid|触らない)/i.test(text)
        ? "hold"
        : "unknown";

  return {
    intent,
    category,
    desiredTier: desiredTierFromText(text, intent),
    rationale: intent === "unknown" ? "No local feedback heuristic matched." : "Local feedback heuristic matched.",
  };
}

export function proposalFromInterpretation(
  note: FeedbackNoteRow,
  interpretation: FeedbackInterpretation,
): FeedbackProposal {
  if (interpretation.category && interpretation.desiredTier) {
    return {
      kind: "policy_override",
      title: `Review ${interpretation.category} routing preference`,
      summary: `Feedback asks to route ${interpretation.category} work toward ${interpretation.desiredTier}.`,
      proposal: {
        action: "add_override_candidate",
        category: interpretation.category,
        desired_tier: interpretation.desiredTier,
        feedback_note_id: note.id,
        source_text: note.text,
      },
    };
  }

  return {
    kind: "evaluation_followup",
    title: "Review uncategorized routing feedback",
    summary: "Feedback could not be mapped to a concrete category and tier locally.",
    proposal: {
      action: "sample_more",
      feedback_note_id: note.id,
      source_text: note.text,
    },
  };
}

function parseFeedbackNotes(args: { dbPath: string; now: number; limit?: number }): {
  notesParsed: number;
  proposalsInserted: number;
} {
  let notesParsed = 0;
  let proposalsInserted = 0;

  for (const note of listFeedbackNotes(args.dbPath, { status: "pending", limit: args.limit ?? 20 })) {
    const interpretation = interpretFeedbackNote(note);
    const proposal = proposalFromInterpretation(note, interpretation);
    const proposalInserted = insertFeedbackProposal(args.dbPath, {
      id: uuidv7(),
      feedbackNoteId: note.id,
      createdAt: args.now,
      kind: proposal.kind,
      title: proposal.title,
      summary: proposal.summary,
      proposalJson: JSON.stringify(proposal.proposal),
    });
    const noteParsed = markFeedbackNoteParsed(args.dbPath, {
      id: note.id,
      parsedJson: JSON.stringify(interpretation),
      resolution: proposalInserted ? "proposal_created" : "proposal_already_exists",
    });

    if (noteParsed) {
      notesParsed += 1;
    }
    if (proposalInserted) {
      proposalsInserted += 1;
    }
  }

  return { notesParsed, proposalsInserted };
}

export function runFeedbackStage(args: {
  dbPath: string;
  batchId: string;
  config: FeedbackConfig;
  now?: number;
}): FeedbackStageResult {
  const now = args.now ?? Date.now();
  const budget = args.config.attention_budget.max_push_questions_per_week;
  const parsed = parseFeedbackNotes({ dbPath: args.dbPath, now });
  const expired = expirePreferenceQueueItems(args.dbPath, now);
  const activeThisWeek = countPreferenceQueueItemsSince(args.dbPath, {
    since: weekStart(now),
    statuses: ["pending", "notified"],
  });
  const available = Math.max(0, budget - activeThisWeek);

  if (available === 0) {
    return { candidates: 0, activeThisWeek, expired, inserted: 0, ...parsed, budget };
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

  return { candidates: candidates.length, activeThisWeek, expired, inserted, ...parsed, budget };
}
