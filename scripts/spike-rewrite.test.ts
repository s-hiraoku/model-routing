import { describe, expect, test } from "bun:test";
import {
  buildClientResponse,
  buildUpstreamUrl,
  findModelInSseText,
  rewriteMessagesBody,
  serveSpikeProxy,
} from "./spike-rewrite";

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

  test("strips incompatible top-level params while rewriting the model", () => {
    const result = rewriteMessagesBody(
      JSON.stringify({
        model: "claude-fable-example",
        effort: "medium",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      "claude-haiku-example",
      ["effort"],
    );

    expect(result.rewritten).toBe(true);
    expect(result.strippedParams).toEqual(["effort"]);
    expect(JSON.parse(result.body)).toEqual({
      model: "claude-haiku-example",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("strips incompatible nested params by dot path", () => {
    const result = rewriteMessagesBody(
      JSON.stringify({
        model: "claude-fable-example",
        output_config: { effort: "medium" },
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      "claude-haiku-example",
      ["output_config.effort"],
    );

    expect(result.rewritten).toBe(true);
    expect(result.strippedParams).toEqual(["output_config.effort"]);
    expect(JSON.parse(result.body)).toEqual({
      model: "claude-haiku-example",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("keeps non-empty parents when stripping nested params", () => {
    const result = rewriteMessagesBody(
      JSON.stringify({
        model: "claude-fable-example",
        output_config: { effort: "medium", other: true },
        messages: [{ role: "user", content: "hello" }],
      }),
      "claude-haiku-example",
      ["output_config.effort"],
    );

    expect(JSON.parse(result.body)).toEqual({
      model: "claude-haiku-example",
      output_config: { other: true },
      messages: [{ role: "user", content: "hello" }],
    });
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

describe("buildClientResponse", () => {
  test("drops compression headers that no longer describe the returned body", async () => {
    const response = buildClientResponse(
      new Response("ok", {
        status: 201,
        headers: {
          "content-encoding": "gzip",
          "content-length": "20",
          "transfer-encoding": "chunked",
          "content-type": "text/plain",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("ok");
  });
});

describe("findModelInSseText", () => {
  test("extracts model from a message_start event", () => {
    expect(
      findModelInSseText(
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8"}}',
          "",
        ].join("\n"),
      ),
    ).toBe("claude-opus-4-8");
  });

  test("ignores malformed data lines", () => {
    expect(findModelInSseText(["event: ping", "data: {", "", "data: [DONE]", ""].join("\n"))).toBeNull();
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
      stripParams: ["output_config.effort"],
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
          output_config: { effort: "medium" },
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
