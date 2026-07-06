import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function bodyPathForRequest(dataDir: string, requestId: string, date = new Date()): string {
  const month = date.toISOString().slice(0, 7);
  return join(dataDir, "bodies", month, `${requestId}.json.zst`);
}

export async function writeZstdJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const tmp = await mkdtemp(join(tmpdir(), "model-routing-body-"));
  const inputPath = join(tmp, "body.json");

  try {
    await writeFile(inputPath, JSON.stringify(payload));

    const proc = Bun.spawn(["zstd", "-q", "-f", inputPath, "-o", path], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`zstd failed with exit code ${exitCode}: ${stderr.trim()}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
