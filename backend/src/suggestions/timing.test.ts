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

    expect(result.expectedHoldMinutes).toBe(5);
    expect(result.expiresAt.toISOString()).toBe("2026-07-13T09:40:00.000Z");
  });

  it("caps swing horizons at ten trading days / fourteen calendar days", () => {
    const result = calculateSuggestionTiming({
      tradeType: "SWING",
      entryPrice: 100,
      target1: 140,
      atr: 2,
      generatedAt: new Date("2026-07-13T04:00:00.000Z"),
    });

    // 40/2 = 20 ATR multiple → capped at 10 trading days (3900 trading minutes)
    expect(result.expectedHoldMinutes).toBe(3900);
    // 10 trading days ≈ 14 calendar days (weekend conversion + buffer, capped)
    expect(result.expiresAt.getTime() - Date.parse("2026-07-13T04:00:00.000Z")).toBe(14 * 24 * 60 * 60_000);
  });
});
