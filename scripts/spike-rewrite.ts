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

  return fetch(upstreamUrl, {
    method: req.method,
    headers,
    body,
    signal: req.signal,
    redirect: "manual",
  });
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
