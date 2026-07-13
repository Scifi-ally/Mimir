import { describe, expect, it } from "vitest";
import { calculateSuggestionTiming } from "./timing";

describe("calculateSuggestionTiming", () => {
  it("bounds intraday suggestions to the remaining market session", () => {
    const result = calculateSuggestionTiming({
      tradeType: "INTRADAY",
      entryPrice: 100,
      target1: 110,
      atr: 1,
      generatedAt: new Date("2026-07-13T09:35:00.000Z"), // 15:05 IST
    });

    expect(result.expectedHoldMinutes).toBe(240);
    expect(result.expiresAt.toISOString()).toBe("2026-07-13T09:40:00.000Z");
  });

  it("keeps swing horizons within three trading-day equivalents", () => {
    const result = calculateSuggestionTiming({
      tradeType: "SWING",
      entryPrice: 100,
      target1: 140,
      atr: 2,
      generatedAt: new Date("2026-07-13T04:00:00.000Z"),
    });

    expect(result.expectedHoldMinutes).toBe(1170);
    expect(result.expiresAt.getTime() - Date.parse("2026-07-13T04:00:00.000Z")).toBe(1755 * 60_000);
  });
});
