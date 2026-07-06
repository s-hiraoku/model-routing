import { describe, expect, test } from "bun:test";
import { buildUpstreamUrl, rewriteMessagesBody, serveSpikeProxy } from "./spike-rewrite";

describe("rewriteMessagesBody", () => {
  test("rewrites only the top-level model field", () => {
    const result = rewriteMessagesBody(
      JSON.stringify({
        model: "claude-sonnet-example",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      "claude-haiku-example",
    );

    expect(result.rewritten).toBe(true);
    expect(result.modelRequested).toBe("claude-sonnet-example");
    expect(result.modelServed).toBe("claude-haiku-example");
    expect(JSON.parse(result.body)).toEqual({
      model: "claude-haiku-example",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("passes through invalid JSON", () => {
    const result = rewriteMessagesBody("{", "claude-haiku-example");

    expect(result.body).toBe("{");
    expect(result.rewritten).toBe(false);
    expect(result.parseError).toBeTruthy();
  });

  test("passes through when rewrite model is not set", () => {
    const body = JSON.stringify({ model: "claude-sonnet-example" });
    const result = rewriteMessagesBody(body, null);

    expect(result.body).toBe(body);
    expect(result.rewritten).toBe(false);
  });
});

describe("buildUpstreamUrl", () => {
  test("preserves path and query while changing origin", () => {
    expect(buildUpstreamUrl("http://127.0.0.1:8484/v1/messages?beta=1", "https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages?beta=1",
    );
  });
});

describe("serveSpikeProxy", () => {
  test("proxies /v1/messages with rewritten model and preserved auth header", async () => {
    let receivedBody: unknown = null;
    let receivedAuth: string | null = null;

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        receivedAuth = req.headers.get("authorization");
        receivedBody = await req.json();

        return Response.json({
          ok: true,
          model: (receivedBody as { model?: string }).model,
        });
      },
    });

    const proxy = serveSpikeProxy({
      port: 0,
      upstream: upstream.url.toString(),
      rewriteModel: "claude-haiku-example",
    });

    try {
      const response = await fetch(new URL("/v1/messages", proxy.url), {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-example",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, model: "claude-haiku-example" });
      expect(receivedAuth).toBe("Bearer test-token");
      expect(receivedBody).toEqual({
        model: "claude-haiku-example",
        messages: [{ role: "user", content: "hello" }],
      });
    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});
