import { describe, expect, test } from "bun:test";
import { classifyHeuristic } from ".";

describe("classifyHeuristic", () => {
  test("classifies prompts by priority", () => {
    expect(classifyHeuristic("このエラーを直して").category).toBe("debug");
    expect(classifyHeuristic("README のドキュメントを更新").category).toBe("docs");
    expect(classifyHeuristic("新規機能を実装して").category).toBe("code_gen");
  });

  test("falls back to unknown", () => {
    expect(classifyHeuristic("こんにちは").category).toBe("unknown");
    expect(classifyHeuristic("こんにちは").confidence).toBe(0);
  });
});
