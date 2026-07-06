export type Tier = "high" | "mid" | "low";

export type TaskCategory = "plan" | "debug" | "code_gen" | "code_edit" | "review" | "test" | "docs" | "unknown";

export type GatewayMode = "passthrough" | "shifting";

export interface RequestFeatures {
  modelRequested: string;
  tierRequested: Tier | null;
  isStreaming: boolean;
  messageCount: number;
  toolCount: number;
  hasToolResults: boolean;
  hasImages: boolean;
  systemHash: string | null;
  promptHash: string;
  approxInputTokens: number;
  lastUserText: string;
}

export function sanitizeResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);

  sanitized.delete("content-encoding");
  sanitized.delete("content-length");
  sanitized.delete("transfer-encoding");

  return sanitized;
}

export function buildClientResponse(
  upstreamResponse: Response,
  body: BodyInit | null = upstreamResponse.body,
): Response {
  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: sanitizeResponseHeaders(upstreamResponse.headers),
  });
}

export function uuidv7(): string {
  return Bun.randomUUIDv7();
}

export function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
