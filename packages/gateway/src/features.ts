import { type RequestFeatures, sha256Hex } from "@model-routing/shared";

type AnthropicMessage = {
  role?: unknown;
  content?: unknown;
};

function countContentItems(messages: AnthropicMessage[], type: string): number {
  let count = 0;

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const item of message.content) {
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === type) {
        count += 1;
      }
    }
  }

  return count;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractRequestFeatures(rawBody: string): RequestFeatures {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body is not a JSON object");
    }

    const body = parsed as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? (body.messages as AnthropicMessage[]) : [];
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const lastUserText = lastUserMessage ? extractText(lastUserMessage.content) : "";
    const systemText = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? null);

    return {
      modelRequested: typeof body.model === "string" ? body.model : "unknown",
      tierRequested: null,
      isStreaming: body.stream === true,
      messageCount: messages.length,
      toolCount: countContentItems(messages, "tool_use"),
      hasToolResults: countContentItems(messages, "tool_result") > 0,
      hasImages: countContentItems(messages, "image") > 0,
      systemHash: body.system == null ? null : sha256Hex(systemText),
      promptHash: sha256Hex(lastUserText || rawBody),
      approxInputTokens: Math.ceil(rawBody.length / 4),
      lastUserText,
    };
  } catch {
    return {
      modelRequested: "unknown",
      tierRequested: null,
      isStreaming: false,
      messageCount: 0,
      toolCount: 0,
      hasToolResults: false,
      hasImages: false,
      systemHash: null,
      promptHash: sha256Hex(rawBody),
      approxInputTokens: Math.ceil(rawBody.length / 4),
      lastUserText: "",
    };
  }
}
