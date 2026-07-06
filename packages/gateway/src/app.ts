import {
  bodyPathForRequest,
  defaultDatabasePath,
  initializeDatabase,
  insertRequestLog,
  writeZstdJson,
} from "@model-routing/datastore";
import { buildClientResponse, type GatewayMode, uuidv7 } from "@model-routing/shared";
import { Hono } from "hono";
import { extractRequestFeatures } from "./features";

export type GatewayOptions = {
  upstream: string;
  mode: GatewayMode;
  dataDir?: string;
  dbPath?: string;
  enableLogging?: boolean;
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

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function requestStatus(httpStatus: number): string {
  if (httpStatus === 429) {
    return "rate_limited";
  }

  if (httpStatus >= 400) {
    return "provider_error";
  }

  return "ok";
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }

  return new Response(stream).text();
}

async function logMessagesRequest(args: {
  dataDir: string;
  dbPath: string;
  requestId: string;
  startedAt: number;
  rawRequestBody: string;
  responseBody: ReadableStream<Uint8Array> | null;
  upstreamResponse: Response;
}): Promise<void> {
  const features = extractRequestFeatures(args.rawRequestBody);
  const responseText = await readStreamText(args.responseBody);
  const bodyPath = bodyPathForRequest(args.dataDir, args.requestId, new Date(args.startedAt));

  await writeZstdJson(bodyPath, {
    request: parseJsonOrRaw(args.rawRequestBody),
    response: parseJsonOrRaw(responseText),
  });

  insertRequestLog(args.dbPath, {
    id: args.requestId,
    sessionId: null,
    replayRunId: null,
    createdAt: args.startedAt,
    modelRequested: features.modelRequested,
    modelServed: features.modelRequested,
    isStreaming: features.isStreaming,
    messageCount: features.messageCount,
    toolCount: features.toolCount,
    hasToolResults: features.hasToolResults,
    hasImages: features.hasImages,
    systemHash: features.systemHash,
    promptHash: features.promptHash,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    status: requestStatus(args.upstreamResponse.status),
    httpStatus: args.upstreamResponse.status,
    stopReason: null,
    latencyMs: Date.now() - args.startedAt,
    ttftMs: null,
    errorMessage: null,
    bodyPath,
  });
}

async function proxyToUpstream(req: Request, options: GatewayOptions): Promise<Response> {
  const upstreamResponse = await fetch(buildUpstreamUrl(req.url, options.upstream), {
    method: req.method,
    headers: buildUpstreamHeaders(req.headers, options.upstream),
    body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
    signal: req.signal,
    redirect: "manual",
  });

  return buildClientResponse(upstreamResponse);
}

async function proxyMessagesRequest(req: Request, options: Required<GatewayOptions>): Promise<Response> {
  const requestId = uuidv7();
  const startedAt = Date.now();
  const rawRequestBody = await req.text();

  const upstreamResponse = await fetch(buildUpstreamUrl(req.url, options.upstream), {
    method: req.method,
    headers: buildUpstreamHeaders(req.headers, options.upstream),
    body: rawRequestBody,
    signal: req.signal,
    redirect: "manual",
  });

  if (!upstreamResponse.body) {
    void logMessagesRequest({
      dataDir: options.dataDir,
      dbPath: options.dbPath,
      requestId,
      startedAt,
      rawRequestBody,
      responseBody: null,
      upstreamResponse,
    }).catch((error) => console.warn(`[gateway] request log failed: ${error}`));

    return buildClientResponse(upstreamResponse);
  }

  const [clientBody, logBody] = upstreamResponse.body.tee();

  void logMessagesRequest({
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    requestId,
    startedAt,
    rawRequestBody,
    responseBody: logBody,
    upstreamResponse,
  }).catch((error) => console.warn(`[gateway] request log failed: ${error}`));

  return buildClientResponse(upstreamResponse, clientBody);
}

export function createGatewayApp(options: GatewayOptions): Hono {
  const app = new Hono();
  const resolvedOptions: Required<GatewayOptions> = {
    dataDir: options.dataDir ?? "data",
    dbPath: options.dbPath ?? defaultDatabasePath(options.dataDir ?? "data"),
    enableLogging: options.enableLogging ?? true,
    mode: options.mode,
    upstream: options.upstream,
  };

  if (resolvedOptions.enableLogging) {
    initializeDatabase(resolvedOptions.dbPath);
  }

  app.get("/internal/healthz", (c) => {
    return c.json({
      status: "ok",
      mode: process.env.MODEL_ROUTING_DISABLED === "1" ? "passthrough" : resolvedOptions.mode,
    });
  });

  app.post("/v1/messages", (c) => {
    if (!resolvedOptions.enableLogging) {
      return proxyToUpstream(c.req.raw, resolvedOptions);
    }

    return proxyMessagesRequest(c.req.raw, resolvedOptions);
  });

  app.all("*", (c) => proxyToUpstream(c.req.raw, resolvedOptions));

  return app;
}
