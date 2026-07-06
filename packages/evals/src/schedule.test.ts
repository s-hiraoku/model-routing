import { describe, expect, test } from "bun:test";
import { assertAllowedHour, isAllowedHour } from "./schedule";

describe("schedule guards", () => {
  test("allows empty schedules and matching hours", () => {
    expect(isAllowedHour(new Date("2026-07-06T03:00:00"), [])).toBe(true);
    expect(isAllowedHour(new Date("2026-07-06T03:00:00"), [3])).toBe(true);
  });

  test("rejects hours outside the allowed list", () => {
    expect(isAllowedHour(new Date("2026-07-06T12:00:00"), [3])).toBe(false);
    expect(() => assertAllowedHour(new Date("2026-07-06T12:00:00"), [3])).toThrow();
  });
});
