type UserPromptSubmitInput = {
  session_id?: unknown;
  cwd?: unknown;
  prompt?: unknown;
};

type GitState = {
  git_head: string | null;
  git_dirty: boolean;
  git_remote: string | null;
};

export type TaskEventPayload = {
  session_id: string;
  cwd: string;
  prompt: string;
  git_head: string | null;
  git_dirty: boolean;
  git_remote: string | null;
};

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  if (exitCode !== 0) {
    return null;
  }

  return output.trim() || null;
}

export async function readGitState(cwd: string): Promise<GitState> {
  const [gitHead, status, gitRemote] = await Promise.all([
    gitOutput(cwd, ["rev-parse", "HEAD"]),
    gitOutput(cwd, ["status", "--porcelain"]),
    gitOutput(cwd, ["remote", "get-url", "origin"]),
  ]);

  return {
    git_head: gitHead,
    git_dirty: Boolean(status),
    git_remote: gitRemote,
  };
}

export async function buildTaskEventPayload(input: UserPromptSubmitInput): Promise<TaskEventPayload | null> {
  if (typeof input.session_id !== "string" || typeof input.prompt !== "string") {
    return null;
  }

  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const gitState = await readGitState(cwd);

  return {
    session_id: input.session_id,
    cwd,
    prompt: input.prompt,
    ...gitState,
  };
}

async function postTaskEvent(payload: TaskEventPayload): Promise<void> {
  const gatewayUrl = new URL(Bun.env.MODEL_ROUTING_GATEWAY_URL ?? "http://127.0.0.1:8484");
  const url = new URL("/internal/task-event", gatewayUrl);

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(500),
  });
}

async function main(): Promise<void> {
  try {
    const rawInput = await readStdin();
    const parsed = JSON.parse(rawInput) as UserPromptSubmitInput;
    const payload = await buildTaskEventPayload(parsed);

    if (payload) {
      await postTaskEvent(payload);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown hook error";
    console.warn(`[model-routing hook] ${message}`);
  }
}

if (import.meta.main) {
  await main();
}
