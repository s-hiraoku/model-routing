export {
  type EvalConfig,
  evalConfigSchema,
  loadEvalConfig,
  loadModelsConfig,
  type ModelsConfig,
  modelsConfigSchema,
} from "./config";

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

export type HeuristicClassification = {
  category: TaskCategory;
  confidence: number;
};

export function classifyHeuristic(promptText: string): HeuristicClassification {
  const rules: Array<[RegExp, TaskCategory]> = [
    [/レビュー|review/i, "review"],
    [/テスト.*(書|作|追加)|test/i, "test"],
    [/(エラー|error|落ち|動かない|直らない|stack ?trace)/i, "debug"],
    [/(設計|方針|アーキテクチャ|どうすべき|計画|plan)/i, "plan"],
    [/(README|ドキュメント|コメント|コミットメッセージ)/i, "docs"],
    [/(リファクタ|直して|修正|変更|リネーム|移動)/i, "code_edit"],
    [/(実装|作って|追加して|新規)/i, "code_gen"],
  ];

  for (const [pattern, category] of rules) {
    if (pattern.test(promptText)) {
      return { category, confidence: 0.8 };
    }
  }

  return { category: "unknown", confidence: 0 };
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

export function resolveGatewayMode(
  requestedMode: GatewayMode,
  env: Record<string, string | undefined> = Bun.env,
): GatewayMode {
  return env.MODEL_ROUTING_DISABLED === "1" ? "passthrough" : requestedMode;
}
