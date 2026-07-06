import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runCommand(command: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

export async function addWorktree(args: { repoPath: string; worktreePath: string; baseCommit: string }): Promise<void> {
  await mkdir(dirname(args.worktreePath), { recursive: true });
  const result = await runCommand(
    ["git", "worktree", "add", "--detach", args.worktreePath, args.baseCommit],
    args.repoPath,
  );
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    const result = await runCommand(["git", "worktree", "remove", "--force", worktreePath], repoPath);
    if (result.exitCode === 0) {
      return;
    }
  } catch {}

  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {}
}

export async function collectPatch(worktreePath: string): Promise<{ patch: string; diffStat: string }> {
  await runCommand(["git", "add", "-A", "-N"], worktreePath);
  const [patch, diffStat] = await Promise.all([
    runCommand(["git", "diff", "--binary"], worktreePath),
    runCommand(["git", "diff", "--stat"], worktreePath),
  ]);

  return {
    patch: patch.stdout,
    diffStat: diffStat.stdout.trim(),
  };
}

export async function writeRunArtifact(runDir: string, name: string, contents: string): Promise<string> {
  const path = join(runDir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}
