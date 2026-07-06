import { describe, expect, test } from "bun:test";
import { classifyLocally, isLikelySelfContained, normalizeClassification } from "./classify";

describe("classifyLocally", () => {
  test("uses heuristic categories and self-contained guard", () => {
    expect(classifyLocally("README を更新して")).toMatchObject({
      category: "docs",
      confidence: 0.8,
      selfContained: true,
    });
    expect(isLikelySelfContained("この流れで push して")).toBe(false);
  });
});

describe("normalizeClassification", () => {
  test("normalizes valid llm output and demotes low confidence to unknown", () => {
    expect(
      normalizeClassification({
        category: "debug",
        confidence: 0.9,
        self_contained: true,
        reason: "error investigation",
      }),
    ).toEqual({
      category: "debug",
      confidence: 0.9,
      selfContained: true,
      reason: "error investigation",
    });

    expect(
      normalizeClassification({
        category: "debug",
        confidence: 0.4,
        self_contained: true,
      }),
    ).toMatchObject({ category: "unknown", confidence: 0.4 });
  });
});
