import { Database } from "bun:sqlite";

export type FeedbackNoteStatus = "pending" | "parsed" | "accepted" | "rejected";

export type FeedbackNoteRow = {
  id: string;
  createdAt: number;
  source: string;
  text: string;
  parsedJson: string | null;
  status: FeedbackNoteStatus;
  resolution: string | null;
};

export type FeedbackNoteInsert = {
  id: string;
  createdAt: number;
  source: string;
  text: string;
  parsedJson?: string | null;
  status?: FeedbackNoteStatus;
  resolution?: string | null;
};

function feedbackNoteFromRow(row: {
  id: string;
  created_at: number;
  source: string;
  text: string;
  parsed_json: string | null;
  status: FeedbackNoteStatus;
  resolution: string | null;
}): FeedbackNoteRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source,
    text: row.text,
    parsedJson: row.parsed_json,
    status: row.status,
    resolution: row.resolution,
  };
}

export function insertFeedbackNote(dbPath: string, row: FeedbackNoteInsert): void {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    db.query(
      `
      INSERT INTO feedback_notes (
        id, created_at, source, text, parsed_json, status, resolution
      ) VALUES (
        $id, $createdAt, $source, $text, $parsedJson, $status, $resolution
      )
      `,
    ).run({
      $id: row.id,
      $createdAt: row.createdAt,
      $source: row.source,
      $text: row.text,
      $parsedJson: row.parsedJson ?? null,
      $status: row.status ?? "pending",
      $resolution: row.resolution ?? null,
    });
  } finally {
    db.close();
  }
}

export function listFeedbackNotes(
  dbPath: string,
  args: { status?: FeedbackNoteStatus; limit?: number } = {},
): FeedbackNoteRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));

    if (args.status) {
      return db
        .query<
          {
            id: string;
            created_at: number;
            source: string;
            text: string;
            parsed_json: string | null;
            status: FeedbackNoteStatus;
            resolution: string | null;
          },
          [FeedbackNoteStatus, number]
        >("SELECT * FROM feedback_notes WHERE status = ? ORDER BY created_at DESC LIMIT ?")
        .all(args.status, limit)
        .map(feedbackNoteFromRow);
    }

    return db
      .query<
        {
          id: string;
          created_at: number;
          source: string;
          text: string;
          parsed_json: string | null;
          status: FeedbackNoteStatus;
          resolution: string | null;
        },
        [number]
      >("SELECT * FROM feedback_notes ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(feedbackNoteFromRow);
  } finally {
    db.close();
  }
}

export function markFeedbackNoteParsed(
  dbPath: string,
  args: { id: string; parsedJson: string; resolution?: string | null },
): boolean {
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const result = db
      .query(
        `
        UPDATE feedback_notes
        SET status = 'parsed',
            parsed_json = $parsedJson,
            resolution = $resolution
        WHERE id = $id
          AND status = 'pending'
        `,
      )
      .run({
        $id: args.id,
        $parsedJson: args.parsedJson,
        $resolution: args.resolution ?? null,
      });
    return result.changes > 0;
  } finally {
    db.close();
  }
}
