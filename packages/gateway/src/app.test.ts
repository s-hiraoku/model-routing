import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsConfig } from "@model-routing/shared";
import type { ShiftPolicy } from "@model-routing/shifter";
import { createGatewayApp, createReplayVariantPolicies } from "./app";

const models: ModelsConfig = {
  tiers: {
    high: { model: "claude-opus-4-8", match: ["claude-opus-*"], strip_params: [] },
    mid: { model: "claude-fable-5", match: ["claude-fable-*"], strip_params: [] },
    low: { model: "claude-haiku-4-5-20251001", match: ["claude-haiku-*"], strip_params: ["output_config.effort"] },
  },
  never_touch: ["claude-haiku-*"],
  subscription: { window_hours: 5, eval_runs_per_window: 20 },
};

const demoteDocsPolicy: ShiftPolicy = {
  version: "test-policy",
  demote: {
    agent_step: { enabled: false, to: "low", min_consecutive: 2 },
    categories: { docs: { to: "low" } },
  },
  promote: { categories: {} },
  governor: {
    quota_guard: false,
    window_burn_threshold: 1,
    degrade_error_rate: 1,
    degrade_pause_minutes: 15,
  },
  overrides: {},
};

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

async function readZstdJson(path: string): Promise<unknown> {
  const proc = Bun.spawn(["zstd", "-q", "-d", "-c", path], {
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(output) as unknown;
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
          "x-mr-variant": "mid+demote",
          "x-remove-me": "1",
        },
        body: JSON.stringify({ model: "claude-fable-5", messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(upstreamHeaders?.get("keep-alive")).toBeNull();
      expect(upstreamHeaders?.get("te")).toBeNull();
      expect(upstreamHeaders?.get("x-remove-me")).toBeNull();
      expect(upstreamHeaders?.get("x-mr-variant")).toBeNull();
    } finally {
      upstream.stop(true);
    }
  });

  test("applies a fixed replay context without enabling production shifting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-variant-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    let upstreamBody: Record<string, unknown> | null = null;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        upstreamBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: "msg_1", model: upstreamBody.model });
      },
    });

    try {
      const app = createGatewayApp({
        upstream: upstream.url.toString(),
        mode: "passthrough",
        dataDir,
        dbPath,
        models,
        variantPolicies: createReplayVariantPolicies(),
        replayContext: { runId: "run-1", variant: "mid+demote" },
      });

      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mr-variant": "high" },
        body: JSON.stringify({
          model: "claude-fable-5",
          stream: false,
          output_config: { effort: "high" },
          messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
                { type: "text", text: "ok" },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(upstreamBody?.model).toBe("claude-haiku-4-5-20251001");
      expect(upstreamBody?.output_config).toEqual({});
      expect(await response.json()).toEqual({ id: "msg_1", model: "claude-haiku-4-5-20251001" });

      const db = new Database(dbPath, { readonly: true });
      try {
        const request = await waitFor(() =>
          db
            .query<{ replay_run_id: string; model_requested: string; model_served: string }, []>(
              "SELECT replay_run_id, model_requested, model_served FROM requests LIMIT 1",
            )
            .get(),
        );
        expect(request).toEqual({
          replay_run_id: "run-1",
          model_requested: "claude-fable-5",
          model_served: "claude-haiku-4-5-20251001",
        });
        const shift = db
          .query<{ gear_from: string; gear_to: string; reason: string }, []>(
            "SELECT gear_from, gear_to, reason FROM shift_events LIMIT 1",
          )
          .get();
        expect(shift).toEqual({ gear_from: "mid", gear_to: "low", reason: "demote_agent_step" });
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not proxy removed replay control endpoints upstream", async () => {
    let upstreamRequests = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        upstreamRequests += 1;
        return Response.json({ ok: true });
      },
    });

    try {
      const app = createGatewayApp({
        upstream: upstream.url.toString(),
        mode: "passthrough",
        enableLogging: false,
      });

      for (const path of ["replay-begin", "replay-end"]) {
        const response = await app.request(`http://127.0.0.1/internal/${path}`, { method: "POST" });
        expect(response.status).toBe(404);
      }
      expect(upstreamRequests).toBe(0);
    } finally {
      upstream.stop(true);
    }
  });

  test("applies production shifting from the loaded policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-shifting-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    let upstreamBody: Record<string, unknown> | null = null;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        upstreamBody = (await req.json()) as Record<string, unknown>;
        return Response.json({ id: "msg_1", model: upstreamBody.model });
      },
    });

    try {
      const app = createGatewayApp({
        upstream: upstream.url.toString(),
        mode: "shifting",
        dataDir,
        dbPath,
        models,
        shiftPolicyRef: { current: demoteDocsPolicy },
      });
      await app.request("http://127.0.0.1/internal/task-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "session-1", cwd: "/repo", prompt: "README を更新して" }),
      });

      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-fable-5",
          output_config: { effort: "high" },
          messages: [{ role: "user", content: "README を更新して" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(upstreamBody?.model).toBe("claude-haiku-4-5-20251001");
      expect(upstreamBody?.output_config).toEqual({});

      const db = new Database(dbPath, { readonly: true });
      try {
        const shift = await waitFor(() =>
          db
            .query<{ gear_from: string; gear_to: string; reason: string; decided_category: string }, []>(
              "SELECT gear_from, gear_to, reason, decided_category FROM shift_events LIMIT 1",
            )
            .get(),
        );
        expect(shift).toEqual({
          gear_from: "mid",
          gear_to: "low",
          reason: "demote_task",
          decided_category: "docs",
        });
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries the original model when a shifted request fails with 4xx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-degrade-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const seenModels: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model?: string };
        seenModels.push(body.model ?? "unknown");
        if (body.model === "claude-haiku-4-5-20251001") {
          return Response.json({ error: "bad model" }, { status: 400 });
        }
        return Response.json({ id: "msg_1", model: body.model });
      },
    });

    try {
      const app = createGatewayApp({
        upstream: upstream.url.toString(),
        mode: "shifting",
        dataDir,
        dbPath,
        models,
        shiftPolicyRef: { current: demoteDocsPolicy },
      });
      await app.request("http://127.0.0.1/internal/task-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "session-1", cwd: "/repo", prompt: "README を更新して" }),
      });

      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-fable-5",
          output_config: { effort: "high" },
          messages: [{ role: "user", content: "README を更新して" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(seenModels).toEqual(["claude-haiku-4-5-20251001", "claude-fable-5"]);
      expect(await response.json()).toEqual({ id: "msg_1", model: "claude-fable-5" });

      const db = new Database(dbPath, { readonly: true });
      try {
        const shift = await waitFor(() =>
          db
            .query<{ gear_from: string; gear_to: string; reason: string }, []>(
              "SELECT gear_from, gear_to, reason FROM shift_events LIMIT 1",
            )
            .get(),
        );
        expect(shift).toEqual({ gear_from: "low", gear_to: "mid", reason: "degrade_guard" });
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
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

      const statsResponse = await app.request("http://127.0.0.1/internal/stats");
      const stats = (await statsResponse.json()) as { requests: { total: number; byStatus: Record<string, number> } };

      expect(statsResponse.status).toBe(200);
      expect(stats.requests.total).toBe(1);
      expect(stats.requests.byStatus.ok).toBe(1);
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("streams SSE responses to the client and logs a reconstructed message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-sse-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":10,"cache_read_input_tokens":3}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(sseBody, {
          headers: { "content-type": "text/event-stream" },
        });
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
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(sseBody);

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = await waitFor(() =>
          db
            .query<
              {
                model_served: string;
                stop_reason: string;
                input_tokens: number;
                output_tokens: number;
                cache_read_tokens: number;
                body_path: string;
              },
              []
            >(
              "SELECT model_served, stop_reason, input_tokens, output_tokens, cache_read_tokens, body_path FROM requests LIMIT 1",
            )
            .get(),
        );

        expect(row.model_served).toBe("claude-fable-5");
        expect(row.stop_reason).toBe("end_turn");
        expect(row.input_tokens).toBe(10);
        expect(row.output_tokens).toBe(1);
        expect(row.cache_read_tokens).toBe(3);

        const stored = (await readZstdJson(row.body_path)) as {
          response?: { body?: { content?: Array<{ text?: string }> } };
        };
        expect(stored.response?.body?.content?.[0]?.text).toBe("ok");
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records a partial streaming response when the tee log body errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-stream-abort-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const partialSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":10}}}\n\n';
    const upstreamResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(partialSse));
          setTimeout(() => controller.error(new Error("client disconnected")), 10);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(upstreamResponse);

    try {
      const app = createGatewayApp({
        upstream: "https://upstream.invalid",
        mode: "passthrough",
        dataDir,
        dbPath,
      });
      const response = await app.request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-fable-5",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      await response.text().catch(() => partialSse);

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = await waitFor(() =>
          db
            .query<{ status: string; error_message: string | null; body_path: string }, []>(
              "SELECT status, error_message, body_path FROM requests LIMIT 1",
            )
            .get(),
        );
        expect(row.status).toBe("client_abort");
        expect(row.error_message).toBe("client disconnected");

        const stored = (await readZstdJson(row.body_path)) as {
          response?: { body?: { id?: string } };
        };
        expect(stored.response?.body?.id).toBe("msg_1");
      } finally {
        db.close();
      }
    } finally {
      fetchSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records quota events for 429 responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-429-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ error: "rate limit" }, { status: 429 });
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
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(429);

      const db = new Database(dbPath, { readonly: true });
      try {
        const quota = await waitFor(() =>
          db.query<{ kind: string; ref_id: string }, []>("SELECT kind, ref_id FROM quota_events LIMIT 1").get(),
        );
        const request = db.query<{ id: string; status: string }, []>("SELECT id, status FROM requests LIMIT 1").get();

        expect(request?.status).toBe("rate_limited");
        expect(quota).toEqual({ kind: "rate_limited", ref_id: request?.id });
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stores only allowlisted headers in body logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-headers-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json(
          { id: "msg_1", model: "claude-fable-5" },
          {
            headers: {
              "anthropic-version": "2023-06-01",
              authorization: "Bearer upstream-secret",
            },
          },
        );
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
        headers: {
          "anthropic-beta": "test-beta",
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-fable-5",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = await waitFor(() =>
          db.query<{ body_path: string }, []>("SELECT body_path FROM requests LIMIT 1").get(),
        );
        const stored = (await readZstdJson(row.body_path)) as {
          request?: { headers?: Record<string, string> };
          response?: { headers?: Record<string, string> };
        };

        expect(stored.request?.headers).toEqual({ "anthropic-beta": "test-beta" });
        expect(stored.response?.headers).toEqual({ "anthropic-version": "2023-06-01" });
      } finally {
        db.close();
      }
    } finally {
      upstream.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records client_abort when the incoming signal aborts upstream fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-gateway-abort-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await Bun.sleep(1000);
        return Response.json({ ok: true });
      },
    });
    const controller = new AbortController();

    try {
      const app = createGatewayApp({
        upstream: upstream.url.toString(),
        mode: "passthrough",
        dataDir,
        dbPath,
      });
      const request = new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-fable-5",
          messages: [{ role: "user", content: "hello" }],
        }),
        signal: controller.signal,
      });

      const responsePromise = app.request(request);
      controller.abort();
      const response = await responsePromise;

      expect(response.status).toBe(499);

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = await waitFor(() =>
          db
            .query<{ status: string; http_status: number | null }, []>(
              "SELECT status, http_status FROM requests LIMIT 1",
            )
            .get(),
        );
        expect(row).toEqual({ status: "client_abort", http_status: null });
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

  test("records internal task events with heuristic classification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-routing-task-event-api-"));
    const dataDir = join(dir, "data");
    const dbPath = join(dataDir, "model-routing.db");

    try {
      const app = createGatewayApp({
        upstream: "http://127.0.0.1:1",
        mode: "passthrough",
        dataDir,
        dbPath,
      });

      const response = await app.request("http://127.0.0.1/internal/task-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: "session-1",
          cwd: "/repo",
          git_head: "abc123",
          git_dirty: false,
          git_remote: "git@example.com/repo.git",
          prompt: "README を更新して",
        }),
      });

      expect(response.status).toBe(200);
      expect((await response.json()) as { task_category?: string }).toHaveProperty("task_category", "docs");

      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.query<{ id: string }, []>("SELECT id FROM sessions").get()).toEqual({ id: "session-1" });
        expect(db.query<{ task_category: string }, []>("SELECT task_category FROM task_events").get()).toEqual({
          task_category: "docs",
        });
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
