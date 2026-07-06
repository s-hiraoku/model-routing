import { describe, expect, test } from "bun:test";
import { metadataFromJsonResponse, parseSseDataEvents, reconstructMessageFromSse } from "./sse";

describe("parseSseDataEvents", () => {
  test("parses JSON data events and ignores done markers", () => {
    expect(parseSseDataEvents('event: ping\ndata: {"type":"ping"}\n\ndata: [DONE]\n\n')).toEqual([{ type: "ping" }]);
  });
});

describe("reconstructMessageFromSse", () => {
  test("reconstructs a streamed text message and usage", () => {
    const text = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":10,"cache_read_input_tokens":4}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n");

    const result = reconstructMessageFromSse(text);

    expect(result.message?.model).toBe("claude-fable-5");
    expect(result.message?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.metadata).toEqual({
      model: "claude-fable-5",
      stopReason: "end_turn",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: null,
    });
  });
});

describe("metadataFromJsonResponse", () => {
  test("extracts model, stop reason, and usage", () => {
    expect(
      metadataFromJsonResponse({
        model: "claude-fable-5",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      }),
    ).toEqual({
      model: "claude-fable-5",
      stopReason: "end_turn",
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
  });
});
