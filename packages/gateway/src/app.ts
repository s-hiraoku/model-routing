import { buildClientResponse, type GatewayMode } from "@model-routing/shared";
import { Hono } from "hono";

export type GatewayOptions = {
  upstream: string;
  mode: GatewayMode;
};

function buildUpstreamUrl(requestUrl: string, upstreamBase: string): string {
  const incoming = new URL(requestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, upstreamBase).toString();
}

function buildUpstreamHeaders(requestHeaders: Headers, upstreamBase: string): Headers {
  const headers = new Headers(requestHeaders);
  const upstream = new URL(upstreamBase);

  headers.set("host", upstream.host);
  headers.delete("content-length");

  return headers;
}

async function proxyToUpstream(req: Request, upstreamBase: string): Promise<Response> {
  const upstreamResponse = await fetch(buildUpstreamUrl(req.url, upstreamBase), {
    method: req.method,
    headers: buildUpstreamHeaders(req.headers, upstreamBase),
    body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
    signal: req.signal,
    redirect: "manual",
  });

  return buildClientResponse(upstreamResponse);
}

export function createGatewayApp(options: GatewayOptions): Hono {
  const app = new Hono();

  app.get("/internal/healthz", (c) => {
    return c.json({
      status: "ok",
      mode: process.env.MODEL_ROUTING_DISABLED === "1" ? "passthrough" : options.mode,
    });
  });

  app.all("*", (c) => proxyToUpstream(c.req.raw, options.upstream));

  return app;
}
