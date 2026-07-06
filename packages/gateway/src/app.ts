import {
  bodyPathForRequest,
  defaultDatabasePath,
  getGatewayStats,
  initializeDatabase,
  insertRequestLog,
  insertTaskEvent,
  upsertSession,
  writeZstdJson,
} from "@model-routing/datastore";
import {
  buildClientResponse,
  classifyHeuristic,
  type GatewayMode,
  resolveGatewayMode,
  sha256Hex,
  uuidv7,
} from "@model-routing/shared";
import { Hono } from "hono";
import { z } from "zod";
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
  const connectionHeader = headers.get("connection");

  headers.set("host", upstream.host);
  headers.delete("content-length");

  if (connectionHeader) {
    for (const headerName of connectionHeader.split(",")) {
      headers.delete(headerName.trim());
    }
  }

  for (const headerName of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(headerName);
  }

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

async function logMessagesGatewayError(args: {
  dataDir: string;
  dbPath: string;
  requestId: string;
  startedAt: number;
  rawRequestBody: string;
  error: Error;
}): Promise<void> {
  const features = extractRequestFeatures(args.rawRequestBody);
  const bodyPath = bodyPathForRequest(args.dataDir, args.requestId, new Date(args.startedAt));

  await writeZstdJson(bodyPath, {
    request: parseJsonOrRaw(args.rawRequestBody),
    response: { error: args.error.message },
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
    status: "gateway_error",
    httpStatus: 502,
    stopReason: null,
    latencyMs: Date.now() - args.startedAt,
    ttftMs: null,
    errorMessage: args.error.message,
    bodyPath,
  });
}

function gatewayErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "unknown upstream error";
  return Response.json({ error: message }, { status: 502 });
}

const taskEventSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  prompt: z.string().min(1),
  git_head: z.string().nullable().optional(),
  git_dirty: z.boolean().optional(),
  git_remote: z.string().nullable().optional(),
});

async function proxyToUpstream(req: Request, options: GatewayOptions): Promise<Response> {
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(buildUpstreamUrl(req.url, options.upstream), {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, options.upstream),
      body: req.method === "GET" || req.method === "HEAD" ? null : req.body,
      signal: req.signal,
      redirect: "manual",
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }

  return buildClientResponse(upstreamResponse);
}

async function proxyMessagesRequest(req: Request, options: Required<GatewayOptions>): Promise<Response> {
  const requestId = uuidv7();
  const startedAt = Date.now();
  const rawRequestBody = await req.text();

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(buildUpstreamUrl(req.url, options.upstream), {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, options.upstream),
      body: rawRequestBody,
      signal: req.signal,
      redirect: "manual",
    });
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error("unknown upstream error");

    void logMessagesGatewayError({
      dataDir: options.dataDir,
      dbPath: options.dbPath,
      requestId,
      startedAt,
      rawRequestBody,
      error: normalizedError,
    }).catch((logError) => console.warn(`[gateway] request log failed: ${logError}`));

    return gatewayErrorResponse(normalizedError);
  }

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
      mode: resolveGatewayMode(resolvedOptions.mode),
    });
  });

  app.get("/internal/stats", (c) => {
    if (!resolvedOptions.enableLogging) {
      return c.json({
        windowMs: 24 * 60 * 60 * 1000,
        requests: { total: 0, byStatus: {} },
        cache: { inputTokens: 0, cacheReadTokens: 0, hitRate: null },
        models: {},
        shifts: { byReason: {}, byGear: {} },
      });
    }

    return c.json(getGatewayStats(resolvedOptions.dbPath));
  });

  app.post("/internal/task-event", async (c) => {
    if (!resolvedOptions.enableLogging) {
      return c.json({ error: "logging disabled" }, 503);
    }

    const parsed = taskEventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid task event" }, 400);
    }

    const now = Date.now();
    const eventId = uuidv7();
    const classification = classifyHeuristic(parsed.data.prompt);

    upsertSession(resolvedOptions.dbPath, {
      id: parsed.data.session_id,
      cwd: parsed.data.cwd,
      gitRemote: parsed.data.git_remote ?? null,
      seenAt: now,
    });
    insertTaskEvent(resolvedOptions.dbPath, {
      id: eventId,
      sessionId: parsed.data.session_id,
      createdAt: now,
      cwd: parsed.data.cwd,
      gitHead: parsed.data.git_head ?? null,
      gitDirty: parsed.data.git_dirty ?? false,
      promptText: parsed.data.prompt,
      promptHash: sha256Hex(parsed.data.prompt),
      taskCategory: classification.category,
      categorySource: "heuristic",
      categoryConfidence: classification.confidence,
      selfContained: null,
    });

    return c.json({
      id: eventId,
      task_category: classification.category,
      category_confidence: classification.confidence,
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
