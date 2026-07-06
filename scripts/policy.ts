import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "yaml";

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

function usage(): string {
  return ["Usage:", "  bun run policy -- rollback <policy-file> [--out config/shift-policy.yaml]"].join("\n");
}

async function commandRollback(args: ParsedArgs): Promise<void> {
  const source = args.positionals[0];
  if (!source) {
    throw new Error("rollback requires a policy file");
  }

  const out = flagString(args, "out", "config/shift-policy.yaml");
  const parsed = parse(await readFile(source, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("policy file must contain a version");
  }

  await mkdir(dirname(out), { recursive: true });
  await copyFile(source, out);
  console.info(`rollback: ${parsed.version} -> ${out}`);
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  switch (args.command) {
    case "rollback":
      await commandRollback(args);
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
