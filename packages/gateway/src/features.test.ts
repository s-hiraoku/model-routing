import { describe, expect, test } from "bun:test";
import { extractRequestFeatures } from "./features";

describe("extractRequestFeatures", () => {
  test("extracts core /v1/messages fields", () => {
    const features = extractRequestFeatures(
      JSON.stringify({
        model: "claude-fable-5",
        stream: true,
        system: "You are concise.",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
              { type: "text", text: "continue" },
            ],
          },
        ],
      }),
    );

    expect(features.modelRequested).toBe("claude-fable-5");
    expect(features.isStreaming).toBe(true);
    expect(features.messageCount).toBe(3);
    expect(features.toolCount).toBe(1);
    expect(features.hasToolResults).toBe(true);
    expect(features.lastUserText).toBe("continue");
    expect(features.promptHash).toHaveLength(64);
    expect(features.systemHash).toHaveLength(64);
  });

  test("falls back safely for unparsable bodies", () => {
    const features = extractRequestFeatures("{");

    expect(features.modelRequested).toBe("unknown");
    expect(features.messageCount).toBe(0);
    expect(features.promptHash).toHaveLength(64);
  });
});
