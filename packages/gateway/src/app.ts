import {
  bodyPathForRequest,
  defaultDatabasePath,
  getGatewayStats,
  initializeDatabase,
  insertQuotaEvent,
  insertRequestLog,
  insertShiftEvent,
  insertTaskEvent,
  type ShiftEventInsert,
  upsertSession,
  writeZstdJson,
} from "@model-routing/datastore";
import {
  buildClientResponse,
  classifyHeuristic,
  type GatewayMode,
  type ModelsConfig,
  resolveGatewayMode,
  sha256Hex,
  type Tier,
  uuidv7,
} from "@model-routing/shared";
import { decideShift, isAgentStep, type SessionShiftState, type ShiftPolicy, withTier } from "@model-routing/shifter";
import { Hono } from "hono";
import { z } from "zod";
import { extractRequestFeatures } from "./features";
import { metadataFromJsonResponse, reconstructMessageFromSse } from "./sse";

export type GatewayOptions = {
  upstream: string;
  mode: GatewayMode;
  dataDir?: string;
  dbPath?: string;
  enableLogging?: boolean;
  models?: ModelsConfig;
  variantPolicies?: Record<string, ShiftPolicy>;
  shiftPolicyRef?: { current: ShiftPolicy | null };
};

type ActiveReplay = {
  runId: string;
  variant: string;
  expiresAt: number;
};

type PreparedMessagesRequest = {
  upstreamBody: string;
  replayRunId: string | null;
  shiftEvent: Omit<ShiftEventInsert, "requestId" | "createdAt"> | null;
  shifted: boolean;
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
  headers.delete("x-mr-variant");

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

function parseResponseForLog(
  contentType: string | null,
  responseText: string,
): {
  payload: unknown;
  metadata: ReturnType<typeof metadataFromJsonResponse>;
} {
  if (contentType?.includes("text/event-stream")) {
    const reconstructed = reconstructMessageFromSse(responseText);
    return {
      payload: reconstructed.message ?? responseText,
      metadata: reconstructed.metadata,
    };
  }

  const payload = parseJsonOrRaw(responseText);
  return {
    payload,
    metadata: metadataFromJsonResponse(payload),
  };
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
  requestHeaders: Headers;
  replayRunId: string | null;
  shiftEvent: Omit<ShiftEventInsert, "requestId" | "createdAt"> | null;
  responseBody: ReadableStream<Uint8Array> | null;
  upstreamResponse: Response;
}): Promise<void> {
  const features = extractRequestFeatures(args.rawRequestBody);
  const responseText = await readStreamText(args.responseBody);
  const response = parseResponseForLog(args.upstreamResponse.headers.get("content-type"), responseText);
  const bodyPath = bodyPathForRequest(args.dataDir, args.requestId, new Date(args.startedAt));

  await writeZstdJson(bodyPath, {
    request: {
      headers: allowedLogHeaders(args.requestHeaders),
      body: parseJsonOrRaw(args.rawRequestBody),
    },
    response: {
      headers: allowedLogHeaders(args.upstreamResponse.headers),
      body: response.payload,
    },
  });

  const status = requestStatus(args.upstreamResponse.status);

  insertRequestLog(args.dbPath, {
    id: args.requestId,
    sessionId: null,
    replayRunId: args.replayRunId,
    createdAt: args.startedAt,
    modelRequested: features.modelRequested,
    modelServed: response.metadata.model ?? features.modelRequested,
    isStreaming: features.isStreaming,
    messageCount: features.messageCount,
    toolCount: features.toolCount,
    hasToolResults: features.hasToolResults,
    hasImages: features.hasImages,
    systemHash: features.systemHash,
    promptHash: features.promptHash,
    inputTokens: response.metadata.inputTokens,
    outputTokens: response.metadata.outputTokens,
    cacheReadTokens: response.metadata.cacheReadTokens,
    cacheWriteTokens: response.metadata.cacheWriteTokens,
    status,
    httpStatus: args.upstreamResponse.status,
    stopReason: response.metadata.stopReason,
    latencyMs: Date.now() - args.startedAt,
    ttftMs: null,
    errorMessage: null,
    bodyPath,
  });

  if (args.shiftEvent) {
    insertShiftEvent(args.dbPath, {
      requestId: args.requestId,
      createdAt: args.startedAt,
      ...args.shiftEvent,
    });
  }

  if (status === "rate_limited") {
    insertQuotaEvent(args.dbPath, {
      id: uuidv7(),
      createdAt: Date.now(),
      kind: "rate_limited",
      refId: args.requestId,
    });
  }
}

async function logMessagesGatewayError(args: {
  dataDir: string;
  dbPath: string;
  requestId: string;
  startedAt: number;
  rawRequestBody: string;
  requestHeaders: Headers;
  replayRunId: string | null;
  shiftEvent: Omit<ShiftEventInsert, "requestId" | "createdAt"> | null;
  error: Error;
  status: "gateway_error" | "client_abort";
}): Promise<void> {
  const features = extractRequestFeatures(args.rawRequestBody);
  const bodyPath = bodyPathForRequest(args.dataDir, args.requestId, new Date(args.startedAt));

  await writeZstdJson(bodyPath, {
    request: {
      headers: allowedLogHeaders(args.requestHeaders),
      body: parseJsonOrRaw(args.rawRequestBody),
    },
    response: {
      headers: {},
      body: { error: args.error.message },
    },
  });

  insertRequestLog(args.dbPath, {
    id: args.requestId,
    sessionId: null,
    replayRunId: args.replayRunId,
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
    status: args.status,
    httpStatus: args.status === "client_abort" ? null : 502,
    stopReason: null,
    latencyMs: Date.now() - args.startedAt,
    ttftMs: null,
    errorMessage: args.error.message,
    bodyPath,
  });

  if (args.shiftEvent) {
    insertShiftEvent(args.dbPath, {
      requestId: args.requestId,
      createdAt: args.startedAt,
      ...args.shiftEvent,
    });
  }
}

function gatewayErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "unknown upstream error";
  return Response.json({ error: message }, { status: 502 });
}

function allowedLogHeaders(headers: Headers): Record<string, string> {
  const allowed = new Set(["user-agent", "anthropic-version", "anthropic-beta"]);
  const logged: Record<string, string> = {};

  for (const [name, value] of headers) {
    if (allowed.has(name.toLowerCase())) {
      logged[name.toLowerCase()] = value;
    }
  }

  return logged;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const taskEventSchema = z.object({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  prompt: z.string().min(1),
  git_head: z.string().nullable().optional(),
  git_dirty: z.boolean().optional(),
  git_remote: z.string().nullable().optional(),
});

const replayControlSchema = z.object({
  run_id: z.string().min(1),
  variant: z.string().min(1),
});

function isLocalRequest(req: Request): boolean {
  const hostname = new URL(req.url).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function stripJsonPath(value: Record<string, unknown>, path: string): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let cursor: unknown = value;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
    delete (cursor as Record<string, unknown>)[parts[parts.length - 1]];
  }
}

function rewriteMessagesBodyForTier(rawBody: string, gear: Tier, models: ModelsConfig): string | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const body = parsed as Record<string, unknown>;
    const tier = models.tiers[gear];
    body.model = tier.model;
    for (const path of tier.strip_params) {
      stripJsonPath(body, path);
    }

    return JSON.stringify(body);
  } catch {
    console.warn("[gateway] variant rewrite skipped: request body is not valid JSON");
    return null;
  }
}

export function createReplayVariantPolicies(): Record<string, ShiftPolicy> {
  return {
    "mid+demote": {
      version: "replay-mid-demote-v1",
      demote: {
        agent_step: { enabled: true, to: "low", min_consecutive: 1 },
        categories: {},
      },
      promote: { categories: {} },
      governor: {
        quota_guard: false,
        window_burn_threshold: 1,
        degrade_error_rate: 1,
        degrade_pause_minutes: 15,
      },
      overrides: {},
    },
  };
}

function resolveReplayVariant(
  req: Request,
  activeReplay: ActiveReplay | null,
): { variant: string; runId: string | null } | null {
  if (!isLocalRequest(req)) {
    return null;
  }

  const headerVariant = req.headers.get("x-mr-variant");
  if (headerVariant) {
    return { variant: headerVariant, runId: null };
  }

  if (activeReplay && activeReplay.expiresAt > Date.now()) {
    return { variant: activeReplay.variant, runId: activeReplay.runId };
  }

  return null;
}

function prepareMessagesRequest(args: {
  req: Request;
  rawRequestBody: string;
  models?: ModelsConfig;
  mode: GatewayMode;
  variantPolicies: Record<string, ShiftPolicy>;
  activeReplay: ActiveReplay | null;
  shiftPolicy: ShiftPolicy | null;
  sessionState: SessionShiftState;
}): PreparedMessagesRequest {
  const replay = resolveReplayVariant(args.req, args.activeReplay);
  if (!replay) {
    return prepareProductionShift(args);
  }

  if (!args.models) {
    return { upstreamBody: args.rawRequestBody, replayRunId: replay.runId, shiftEvent: null, shifted: false };
  }

  const policy = args.variantPolicies[replay.variant];
  if (!policy) {
    return { upstreamBody: args.rawRequestBody, replayRunId: replay.runId, shiftEvent: null, shifted: false };
  }

  const prepared = applyPolicyShift({
    rawRequestBody: args.rawRequestBody,
    models: args.models,
    policy,
    sessionState: {
      taskEventId: null,
      category: null,
      currentGear: null,
      demotedStreak: 0,
      isTaskStart: false,
    },
    updateSessionState: false,
  });

  return { ...prepared, replayRunId: replay.runId };
}

function prepareProductionShift(args: {
  rawRequestBody: string;
  models?: ModelsConfig;
  mode: GatewayMode;
  shiftPolicy: ShiftPolicy | null;
  sessionState: SessionShiftState;
}): PreparedMessagesRequest {
  if (resolveGatewayMode(args.mode) !== "shifting" || !args.models || !args.shiftPolicy) {
    return { upstreamBody: args.rawRequestBody, replayRunId: null, shiftEvent: null, shifted: false };
  }

  return {
    ...applyPolicyShift({
      rawRequestBody: args.rawRequestBody,
      models: args.models,
      policy: args.shiftPolicy,
      sessionState: args.sessionState,
      updateSessionState: true,
    }),
    replayRunId: null,
  };
}

function applyPolicyShift(args: {
  rawRequestBody: string;
  models: ModelsConfig;
  policy: ShiftPolicy;
  sessionState: SessionShiftState;
  updateSessionState: boolean;
}): Omit<PreparedMessagesRequest, "replayRunId"> {
  const features = withTier(extractRequestFeatures(args.rawRequestBody), args.models);
  const decision = decideShift({
    features,
    state: args.sessionState,
    policy: args.policy,
    enabled: true,
  });
  updateSessionStateAfterDecision(args.sessionState, features, decision.gear, decision.reason, args.updateSessionState);

  if (!features.tierRequested || decision.gear === features.tierRequested) {
    return { upstreamBody: args.rawRequestBody, shiftEvent: null, shifted: false };
  }

  const rewritten = rewriteMessagesBodyForTier(args.rawRequestBody, decision.gear, args.models);
  if (!rewritten) {
    return { upstreamBody: args.rawRequestBody, shiftEvent: null, shifted: false };
  }

  return {
    upstreamBody: rewritten,
    shifted: true,
    shiftEvent: {
      policyVersion: decision.policyVersion ?? "none",
      taskEventId: args.sessionState.taskEventId,
      decidedCategory: args.sessionState.category,
      gearFrom: features.tierRequested,
      gearTo: decision.gear,
      reason: decision.reason,
    },
  };
}

function updateSessionStateAfterDecision(
  state: SessionShiftState,
  features: ReturnType<typeof withTier>,
  gear: Tier,
  reason: string,
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }

  state.demotedStreak = isAgentStep(features) ? state.demotedStreak + 1 : 0;
  if (reason === "promote_task" || reason === "demote_task") {
    state.currentGear = gear;
  }
  state.isTaskStart = false;
}

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
    if (isAbortError(error)) {
      return new Response(null, { status: 499 });
    }

    return gatewayErrorResponse(error);
  }

  return buildClientResponse(upstreamResponse);
}

async function proxyMessagesRequest(
  req: Request,
  options: Required<GatewayOptions>,
  activeReplay: ActiveReplay | null,
  sessionState: SessionShiftState,
): Promise<Response> {
  const requestId = uuidv7();
  const startedAt = Date.now();
  const rawRequestBody = await req.text();
  const prepared = prepareMessagesRequest({
    req,
    rawRequestBody,
    models: options.models,
    mode: options.mode,
    variantPolicies: options.variantPolicies,
    activeReplay,
    shiftPolicy: options.shiftPolicyRef.current,
    sessionState,
  });
  let effectivePrepared = prepared;

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(buildUpstreamUrl(req.url, options.upstream), {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, options.upstream),
      body: prepared.upstreamBody,
      signal: req.signal,
      redirect: "manual",
    });
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error("unknown upstream error");
    const status = isAbortError(error) ? "client_abort" : "gateway_error";

    void logMessagesGatewayError({
      dataDir: options.dataDir,
      dbPath: options.dbPath,
      requestId,
      startedAt,
      rawRequestBody,
      requestHeaders: req.headers,
      replayRunId: prepared.replayRunId,
      shiftEvent: prepared.shiftEvent,
      error: normalizedError,
      status,
    }).catch((logError) => console.warn(`[gateway] request log failed: ${logError}`));

    if (status === "client_abort") {
      return new Response(null, { status: 499 });
    }

    return gatewayErrorResponse(normalizedError);
  }

  if (prepared.shifted && upstreamResponse.status >= 400 && upstreamResponse.status < 500) {
    try {
      upstreamResponse = await fetch(buildUpstreamUrl(req.url, options.upstream), {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, options.upstream),
        body: rawRequestBody,
        signal: req.signal,
        redirect: "manual",
      });
      effectivePrepared = {
        ...prepared,
        upstreamBody: rawRequestBody,
        shifted: false,
        shiftEvent: prepared.shiftEvent
          ? {
              ...prepared.shiftEvent,
              gearFrom: prepared.shiftEvent.gearTo,
              gearTo: prepared.shiftEvent.gearFrom,
              reason: "degrade_guard",
            }
          : null,
      };
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error("unknown upstream error");
      return gatewayErrorResponse(normalizedError);
    }
  }

  if (!upstreamResponse.body) {
    void logMessagesRequest({
      dataDir: options.dataDir,
      dbPath: options.dbPath,
      requestId,
      startedAt,
      rawRequestBody,
      requestHeaders: req.headers,
      replayRunId: effectivePrepared.replayRunId,
      shiftEvent: effectivePrepared.shiftEvent,
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
    requestHeaders: req.headers,
    replayRunId: effectivePrepared.replayRunId,
    shiftEvent: effectivePrepared.shiftEvent,
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
    models: options.models,
    upstream: options.upstream,
    variantPolicies: options.variantPolicies ?? {},
    shiftPolicyRef: options.shiftPolicyRef ?? { current: null },
  };
  let activeReplay: ActiveReplay | null = null;
  const sessionState: SessionShiftState = {
    taskEventId: null,
    category: null,
    currentGear: null,
    demotedStreak: 0,
    isTaskStart: false,
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
        cache: {
          inputTokens: 0,
          cacheReadTokens: 0,
          hitRate: null,
          byShift: {
            shifted: { inputTokens: 0, cacheReadTokens: 0, hitRate: null },
            unshifted: { inputTokens: 0, cacheReadTokens: 0, hitRate: null },
          },
        },
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
    sessionState.taskEventId = eventId;
    sessionState.category = classification.category;
    sessionState.currentGear = null;
    sessionState.demotedStreak = 0;
    sessionState.isTaskStart = true;

    return c.json({
      id: eventId,
      task_category: classification.category,
      category_confidence: classification.confidence,
    });
  });

  app.post("/internal/replay-begin", async (c) => {
    if (!isLocalRequest(c.req.raw)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const parsed = replayControlSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid replay control" }, 400);
    }

    activeReplay = {
      runId: parsed.data.run_id,
      variant: parsed.data.variant,
      expiresAt: Date.now() + 30 * 60 * 1000,
    };

    return c.json({ status: "ok" });
  });

  app.post("/internal/replay-end", async (c) => {
    if (!isLocalRequest(c.req.raw)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const parsed = replayControlSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid replay control" }, 400);
    }

    if (activeReplay?.runId === parsed.data.run_id) {
      activeReplay = null;
    }

    return c.json({ status: "ok" });
  });

  app.post("/v1/messages", (c) => {
    if (!resolvedOptions.enableLogging) {
      return proxyToUpstream(c.req.raw, resolvedOptions);
    }

    return proxyMessagesRequest(c.req.raw, resolvedOptions, activeReplay, sessionState);
  });

  app.all("*", (c) => proxyToUpstream(c.req.raw, resolvedOptions));

  return app;
}
