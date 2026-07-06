export type ReconstructedMessage = {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content: Array<Record<string, unknown>>;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: Record<string, number>;
};

export type ResponseMetadata = {
  model: string | null;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

const emptyMetadata: ResponseMetadata = {
  model: null,
  stopReason: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
};

function numericField(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === "number" ? record[key] : null;
}

function metadataFromUsage(
  model: string | null,
  stopReason: string | null,
  usage: Record<string, unknown> | null,
): ResponseMetadata {
  if (!usage) {
    return { ...emptyMetadata, model, stopReason };
  }

  return {
    model,
    stopReason,
    inputTokens: numericField(usage, "input_tokens"),
    outputTokens: numericField(usage, "output_tokens"),
    cacheReadTokens: numericField(usage, "cache_read_input_tokens"),
    cacheWriteTokens: numericField(usage, "cache_creation_input_tokens"),
  };
}

export function parseSseDataEvents(text: string): unknown[] {
  const events: unknown[] = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      events.push(data);
    }
  }

  return events;
}

export function reconstructMessageFromSse(text: string): {
  message: ReconstructedMessage | null;
  metadata: ResponseMetadata;
} {
  const message: ReconstructedMessage = { content: [] };
  let sawMessage = false;

  for (const event of parseSseDataEvents(text)) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }

    const record = event as Record<string, unknown>;

    if (record.type === "message_start" && record.message && typeof record.message === "object") {
      sawMessage = true;
      const started = record.message as Record<string, unknown>;
      Object.assign(message, started);
      message.content = [];

      if (Array.isArray(started.content)) {
        message.content = started.content.filter((item) => item && typeof item === "object") as Array<
          Record<string, unknown>
        >;
      }
      continue;
    }

    if (record.type === "content_block_start" && typeof record.index === "number") {
      const contentBlock = record.content_block;
      if (contentBlock && typeof contentBlock === "object" && !Array.isArray(contentBlock)) {
        message.content[record.index] = { ...(contentBlock as Record<string, unknown>) };
      }
      continue;
    }

    if (record.type === "content_block_delta" && typeof record.index === "number") {
      const delta = record.delta;
      const block = message.content[record.index] ?? { type: "text", text: "" };

      if (delta && typeof delta === "object" && !Array.isArray(delta)) {
        const typedDelta = delta as Record<string, unknown>;
        if (typedDelta.type === "text_delta" && typeof typedDelta.text === "string") {
          block.text = `${typeof block.text === "string" ? block.text : ""}${typedDelta.text}`;
        } else if (typedDelta.type === "input_json_delta" && typeof typedDelta.partial_json === "string") {
          block.partial_json = `${typeof block.partial_json === "string" ? block.partial_json : ""}${typedDelta.partial_json}`;
        }
      }

      message.content[record.index] = block;
      continue;
    }

    if (record.type === "message_delta") {
      if (record.delta && typeof record.delta === "object" && !Array.isArray(record.delta)) {
        const delta = record.delta as Record<string, unknown>;
        if ("stop_reason" in delta) {
          message.stop_reason = typeof delta.stop_reason === "string" ? delta.stop_reason : null;
        }
        if ("stop_sequence" in delta) {
          message.stop_sequence = typeof delta.stop_sequence === "string" ? delta.stop_sequence : null;
        }
      }

      if (record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)) {
        message.usage = { ...(message.usage ?? {}), ...(record.usage as Record<string, number>) };
      }
    }
  }

  if (!sawMessage) {
    return { message: null, metadata: emptyMetadata };
  }

  return {
    message,
    metadata: metadataFromUsage(message.model ?? null, message.stop_reason ?? null, message.usage ?? null),
  };
}

export function metadataFromJsonResponse(response: unknown): ResponseMetadata {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return emptyMetadata;
  }

  const record = response as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage) ? record.usage : null;

  return metadataFromUsage(
    typeof record.model === "string" ? record.model : null,
    typeof record.stop_reason === "string" ? record.stop_reason : null,
    usage as Record<string, unknown> | null,
  );
}
