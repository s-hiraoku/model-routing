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

  test("applies the kill switch at request time", async () => {
    const app = createGatewayApp({ upstream: "http://127.0.0.1:9", mode: "shifting", enableLogging: false });
    const previous = process.env.MODEL_ROUTING_DISABLED;

    try {
      process.env.MODEL_ROUTING_DISABLED = "1";
      const response = await app.request("http://127.0.0.1/internal/healthz");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", mode: "passthrough" });
    } finally {
      if (previous === undefined) {
        delete process.env.MODEL_ROUTING_DISABLED;
      } else {
        process.env.MODEL_ROUTING_DISABLED = previous;
      }
    }
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

  test("strips hop-by-hop headers before proxying", async () => {
    let upstreamHeaders: Headers | null = null;

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        upstreamHeaders = req.headers;
        return Response.json({ ok: true });
      },
    });

    const app = createGatewayApp({ upstream: upstream.url.toString(), mode: "passthrough", enableLogging: false });

    try {
      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: {
          connection: "x-remove-me",
          "content-type": "application/json",
          "keep-alive": "timeout=5",
          te: "trailers",
          "x-remove-me": "1",
        },
        body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(upstreamHeaders?.get("keep-alive")).toBeNull();
      expect(upstreamHeaders?.get("te")).toBeNull();
      expect(upstreamHeaders?.get("x-remove-me")).toBeNull();
    } finally {
      upstream.stop(true);
    }
  });

  test("returns 502 when the upstream fetch fails", async () => {
    const app = createGatewayApp({ upstream: "http://127.0.0.1:1", mode: "passthrough", enableLogging: false });
    const response = await app.request("http://127.0.0.1/v1/models");

    expect(response.status).toBe(502);
    expect((await response.json()) as { error?: string }).toHaveProperty("error");
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

  test("logs gateway_error for failed /v1/messages upstream fetches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-error-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");

    try {
      const app = createGatewayApp({
        upstream: "http://127.0.0.1:1",
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

      expect(response.status).toBe(502);

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = await waitFor(() =>
          db
            .query<{ status: string; http_status: number; error_message: string | null; body_path: string }, []>(
              "SELECT status, http_status, error_message, body_path FROM requests LIMIT 1",
            )
            .get(),
        );

        expect(row.status).toBe("gateway_error");
        expect(row.http_status).toBe(502);
        expect(row.error_message).toBeTruthy();
        expect(existsSync(row.body_path)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
