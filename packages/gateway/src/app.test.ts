import { describe, expect, test } from "bun:test";
import { createGatewayApp } from "./app";

describe("gateway app", () => {
  test("reports health in passthrough mode", async () => {
    const app = createGatewayApp({ upstream: "http://127.0.0.1:9", mode: "passthrough" });
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

    const app = createGatewayApp({ upstream: upstream.url.toString(), mode: "passthrough" });

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
});
