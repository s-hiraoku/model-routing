import { Database } from "bun:sqlite";

export type FeedbackProposalStatus = "pending" | "accepted" | "rejected" | "applied";

export type FeedbackProposalRow = {
  id: string;
  feedbackNoteId: string;
  createdAt: number;
  kind: string;
  title: string;
  summary: string;
  proposalJson: string;
  status: FeedbackProposalStatus;
  decidedAt: number | null;
  decisionNote: string | null;
};

export type FeedbackProposalInsert = {
  id: string;
  feedbackNoteId: string;
  createdAt: number;
  kind: string;
  title: string;
  summary: string;
  proposalJson: string;
  status?: FeedbackProposalStatus;
};

type FeedbackProposalDbRow = {
  id: string;
  feedback_note_id: string;
  created_at: number;
  kind: string;
  title: string;
  summary: string;
  proposal_json: string;
  status: FeedbackProposalStatus;
  decided_at: number | null;
  decision_note: string | null;
};

function feedbackProposalFromRow(row: FeedbackProposalDbRow): FeedbackProposalRow {
  return {
    id: row.id,
    feedbackNoteId: row.feedback_note_id,
    createdAt: row.created_at,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    proposalJson: row.proposal_json,
    status: row.status,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  };
}

export function insertFeedbackProposal(dbPath: string, row: FeedbackProposalInsert): boolean {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        INSERT OR IGNORE INTO feedback_proposals (
          id, feedback_note_id, created_at, kind, title, summary,
          proposal_json, status
        ) VALUES (
          $id, $feedbackNoteId, $createdAt, $kind, $title, $summary,
          $proposalJson, $status
        )
        `,
      )
      .run({
        $id: row.id,
        $feedbackNoteId: row.feedbackNoteId,
        $createdAt: row.createdAt,
        $kind: row.kind,
        $title: row.title,
        $summary: row.summary,
        $proposalJson: row.proposalJson,
        $status: row.status ?? "pending",
      });

    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function listFeedbackProposals(
  dbPath: string,
  args: { status?: FeedbackProposalStatus; limit?: number } = {},
): FeedbackProposalRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));

    if (args.status) {
      return db
        .query<FeedbackProposalDbRow, [FeedbackProposalStatus, number]>(
          "SELECT * FROM feedback_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(args.status, limit)
        .map(feedbackProposalFromRow);
    }

    return db
      .query<FeedbackProposalDbRow, [number]>("SELECT * FROM feedback_proposals ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(feedbackProposalFromRow);
  } finally {
    db.close();
  }
}

export function getFeedbackProposal(dbPath: string, id: string): FeedbackProposalRow | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query<FeedbackProposalDbRow, [string]>("SELECT * FROM feedback_proposals WHERE id = ?").get(id);
    return row ? feedbackProposalFromRow(row) : null;
  } finally {
    db.close();
  }
}

export function decideFeedbackProposal(
  dbPath: string,
  args: {
    id: string;
    status: Extract<FeedbackProposalStatus, "accepted" | "rejected">;
    decidedAt: number;
    note?: string;
  },
): boolean {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        UPDATE feedback_proposals
        SET status = $status,
            decided_at = $decidedAt,
            decision_note = $note
        WHERE id = $id
          AND status = 'pending'
        `,
      )
      .run({
        $id: args.id,
        $status: args.status,
        $decidedAt: args.decidedAt,
        $note: args.note ?? null,
      });
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function markFeedbackProposalApplied(dbPath: string, args: { id: string; decidedAt: number }): boolean {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        UPDATE feedback_proposals
        SET status = 'applied',
            decided_at = $decidedAt
        WHERE id = $id
          AND status = 'accepted'
        `,
      )
      .run({ $id: args.id, $decidedAt: args.decidedAt });
    return result.changes > 0;
  } finally {
    db.close();
  }
}
