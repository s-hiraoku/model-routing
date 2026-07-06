import { createReviewUiApp } from "./app";

const DEFAULT_PORT = 8585;

function envNumber(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

const port = envNumber("PORT", DEFAULT_PORT);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: createReviewUiApp({ dbPath: Bun.env.DB_PATH }).fetch,
});

console.info(`[review-ui] listening on http://127.0.0.1:${port}`);
