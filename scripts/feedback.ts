import {
  defaultDatabasePath,
  type FeedbackNoteStatus,
  initializeDatabase,
  insertFeedbackNote,
  listFeedbackNotes,
} from "@model-routing/datastore";

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue != null) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { command, positionals, flags };
}

function flagString(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : fallback;
}

function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags.get(name);
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function statusFlag(args: ParsedArgs): FeedbackNoteStatus | undefined {
  const value = args.flags.get("status");
  if (value == null) {
    return undefined;
  }
  if (value === "pending" || value === "parsed" || value === "accepted" || value === "rejected") {
    return value;
  }
  throw new Error("--status must be one of: pending, parsed, accepted, rejected");
}

function usage(): string {
  return [
    "Usage:",
    '  bun run feedback -- add "text" [--source cli] [--db data/model-routing.db]',
    "  bun run feedback -- list [--status pending] [--limit 20] [--db data/model-routing.db]",
  ].join("\n");
}

async function commandAdd(args: ParsedArgs): Promise<void> {
  const text = args.positionals.join(" ").trim();
  if (text.length === 0) {
    throw new Error("add requires feedback text");
  }

  const dbPath = flagString(args, "db", defaultDatabasePath());
  initializeDatabase(dbPath);

  const id = Bun.randomUUIDv7();
  insertFeedbackNote(dbPath, {
    id,
    createdAt: Date.now(),
    source: flagString(args, "source", "cli"),
    text,
  });
  console.info(`feedback: added ${id}`);
}

async function commandList(args: ParsedArgs): Promise<void> {
  const dbPath = flagString(args, "db", defaultDatabasePath());
  initializeDatabase(dbPath);

  for (const note of listFeedbackNotes(dbPath, { status: statusFlag(args), limit: flagNumber(args, "limit", 20) })) {
    console.info(JSON.stringify(note));
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "add":
      await commandAdd(args);
      return;
    case "list":
      await commandList(args);
      return;
    default:
      console.info(usage());
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
