import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "./app";

async function waitFor<T>(read: () => T | null, timeoutMs = 1000): Promise<T> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) {
      return value;
    }

    await Bun.sleep(20);
  }

  throw new Error("timed out waiting for value");
}

describe("gateway app", () => {
  test("reports health in passthrough mode", async () => {
    const app = createGatewayApp({ upstream: "http://127.0.0.1:9", mode: "passthrough", enableLogging: false });
    const response = await app.request("http://127.0.0.1/internal/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", mode: "passthrough" });
  });

  test("proxies requests to the configured upstream", async () => {
    let upstreamBody: unknown = null;
    let upstreamAuth: string | null = null;

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        upstreamAuth = req.headers.get("authorization");
        upstreamBody = await req.json();
        return Response.json({ ok: true, path: new URL(req.url).pathname });
      },
    });

    const app = createGatewayApp({ upstream: upstream.url.toString(), mode: "passthrough", enableLogging: false });

    try {
      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, path: "/v1/messages" });
      expect(upstreamAuth).toBe("Bearer test-token");
      expect(upstreamBody).toEqual({ model: "claude-fable-5", messages: [] });
    } finally {
      upstream.stop(true);
    }
  });

  test("logs /v1/messages request metadata and compressed bodies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ id: "msg_1", model: "claude-fable-5" });
      },
    });

    try {
      const app = createGatewayApp({
        upstream: upstream.url.toString(),
        mode: "passthrough",
        dataDir,
        dbPath,
      });

      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-fable-5",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "msg_1", model: "claude-fable-5" });

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = await waitFor(() =>
          db
            .query<{ model_requested: string; status: string; body_path: string }, []>(
              "SELECT model_requested, status, body_path FROM requests LIMIT 1",
            )
            .get(),
        );

        expect(row.model_requested).toBe("claude-fable-5");
        expect(row.status).toBe("ok");
        expect(existsSync(row.body_path)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
