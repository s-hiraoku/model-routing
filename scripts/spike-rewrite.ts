type RewriteResult = {
  body: string;
  modelRequested: string | null;
  modelServed: string | null;
  rewritten: boolean;
  parseError: string | null;
};

const DEFAULT_PORT = 8484;
const DEFAULT_UPSTREAM = "https://api.anthropic.com";

type SpikeProxyOptions = {
  hostname?: string;
  port?: number;
  upstream: string;
  rewriteModel: string | null;
};

export function rewriteMessagesBody(rawBody: string, rewriteModel: string | null): RewriteResult {
  if (!rewriteModel) {
    return {
      body: rawBody,
      modelRequested: null,
      modelServed: null,
      rewritten: false,
      parseError: null,
    };
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        body: rawBody,
        modelRequested: null,
        modelServed: null,
        rewritten: false,
        parseError: "body is not a JSON object",
      };
    }

    const messageBody = parsed as Record<string, unknown>;
    const modelRequested = typeof messageBody.model === "string" ? messageBody.model : null;

    if (!modelRequested) {
      return {
        body: rawBody,
        modelRequested: null,
        modelServed: null,
        rewritten: false,
        parseError: "body.model is not a string",
      };
    }

    if (modelRequested === rewriteModel) {
      return {
        body: rawBody,
        modelRequested,
        modelServed: modelRequested,
        rewritten: false,
        parseError: null,
      };
    }

    messageBody.model = rewriteModel;

    return {
      body: JSON.stringify(messageBody),
      modelRequested,
      modelServed: rewriteModel,
      rewritten: true,
      parseError: null,
    };
  } catch (error) {
    return {
      body: rawBody,
      modelRequested: null,
      modelServed: null,
      rewritten: false,
      parseError: error instanceof Error ? error.message : "failed to parse JSON body",
    };
  }
}

export function buildUpstreamUrl(requestUrl: string, upstreamBase: string): string {
  const incoming = new URL(requestUrl);
  const upstream = new URL(upstreamBase);
  return new URL(`${incoming.pathname}${incoming.search}`, upstream).toString();
}

function buildUpstreamHeaders(requestHeaders: Headers, upstreamBase: string): Headers {
  const headers = new Headers(requestHeaders);
  const upstream = new URL(upstreamBase);

  headers.set("host", upstream.host);
  headers.delete("content-length");

  return headers;
}

export function buildClientResponse(upstreamResponse: Response): Response {
  const headers = new Headers(upstreamResponse.headers);

  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export function findModelInSseText(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const event = parsed as Record<string, unknown>;
      const message = event.message;

      if (message && typeof message === "object" && !Array.isArray(message)) {
        const model = (message as Record<string, unknown>).model;
        if (typeof model === "string") {
          return model;
        }
      }

      if (typeof event.model === "string") {
        return event.model;
      }
    } catch {}
  }

  return null;
}

async function logResponseModel(contentType: string | null, body: ReadableStream<Uint8Array>): Promise<void> {
  if (contentType?.includes("text/event-stream")) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    try {
      while (buffered.length < 128_000) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffered += decoder.decode(value, { stream: true });
        const model = findModelInSseText(buffered);

        if (model) {
          console.info(`[spike] response model: ${model}`);
          await reader.cancel();
          return;
        }
      }

      buffered += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    const model = findModelInSseText(buffered);
    if (model) {
      console.info(`[spike] response model: ${model}`);
    }

    return;
  }

  const text = await new Response(body).text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === "string") {
        console.info(`[spike] response model: ${model}`);
      }
    }
  } catch {
    // Non-JSON responses are valid for provider errors; status is visible to the client.
  }
}

function buildLoggedClientResponse(upstreamResponse: Response): Response {
  if (!upstreamResponse.body) {
    return buildClientResponse(upstreamResponse);
  }

  const [clientBody, logBody] = upstreamResponse.body.tee();
  void logResponseModel(upstreamResponse.headers.get("content-type"), logBody).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown response log error";
    console.warn(`[spike] response model log warning: ${message}`);
  });

  const headers = new Headers(upstreamResponse.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  return new Response(clientBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

async function proxyRequest(req: Request, upstreamBase: string, rewriteModel: string | null): Promise<Response> {
  const url = new URL(req.url);
  const upstreamUrl = buildUpstreamUrl(req.url, upstreamBase);
  const headers = buildUpstreamHeaders(req.headers, upstreamBase);

  let body: BodyInit | null = null;

  if (req.method !== "GET" && req.method !== "HEAD") {
    const rawBody = await req.text();

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const rewrite = rewriteMessagesBody(rawBody, rewriteModel);
      body = rewrite.body;

      if (rewrite.parseError) {
        console.warn(`[spike] /v1/messages parse warning: ${rewrite.parseError}; passing through`);
      } else if (rewrite.rewritten) {
        console.info(`[spike] rewrote model: ${rewrite.modelRequested} -> ${rewrite.modelServed}`);
      } else {
        console.info(`[spike] passed through model: ${rewrite.modelRequested ?? "unknown"}`);
      }
    } else {
      body = rawBody;
    }
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body,
    signal: req.signal,
    redirect: "manual",
  });

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return buildLoggedClientResponse(upstreamResponse);
  }

  return buildClientResponse(upstreamResponse);
}

function envNumber(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function serveSpikeProxy(options: SpikeProxyOptions) {
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? DEFAULT_PORT,
    async fetch(req) {
      try {
        return await proxyRequest(req, options.upstream, options.rewriteModel);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown gateway error";
        console.error(`[spike] gateway error: ${message}`);
        return Response.json({ error: message }, { status: 502 });
      }
    },
  });
}

function startServer(): void {
  const port = envNumber("PORT", DEFAULT_PORT);
  const upstream = Bun.env.UPSTREAM ?? DEFAULT_UPSTREAM;
  const rewriteModel = Bun.env.REWRITE_MODEL ?? null;

  serveSpikeProxy({ port, upstream, rewriteModel });

  console.info(`[spike] listening on http://127.0.0.1:${port}`);
  console.info(`[spike] upstream: ${upstream}`);
  console.info(`[spike] rewrite model: ${rewriteModel ?? "(disabled; passthrough)"}`);
}

if (import.meta.main) {
  startServer();
}
