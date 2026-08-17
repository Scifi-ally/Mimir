import { afterEach, describe, expect, it } from "vitest";
import { evaluateSignalFreshness } from "./signal_freshness";

const NOW = new Date("2026-08-17T10:00:00.000Z");

afterEach(() => {
  delete process.env.MIMIR_MAX_INTRADAY_SIGNAL_AGE_MINUTES;
  delete process.env.MIMIR_MAX_SWING_SIGNAL_AGE_MINUTES;
});

describe("evaluateSignalFreshness", () => {
  it("accepts an intraday signal within the five-minute default", () => {
    const result = evaluateSignalFreshness({
      tradeType: "INTRADAY",
      generatedAt: "2026-08-17T09:56:00.000Z",
      now: NOW,
    });
    expect(result).toMatchObject({ accepted: true, ageMinutes: 4, maxAgeMinutes: 5, reason: "fresh" });
  });

  it("rejects an intraday signal older than the default freshness window", () => {
    const result = evaluateSignalFreshness({
      tradeType: "INTRADAY",
      generatedAt: "2026-08-17T09:54:59.000Z",
      now: NOW,
    });
    expect(result).toMatchObject({ accepted: false, maxAgeMinutes: 5, reason: "stale_signal" });
    expect(result.ageMinutes).toBeGreaterThan(5);
  });

  it("rejects missing and malformed timestamps instead of treating them as current", () => {
    expect(evaluateSignalFreshness({ tradeType: "INTRADAY", now: NOW })).toMatchObject({
      accepted: false,
      reason: "missing_timestamp",
    });
    expect(evaluateSignalFreshness({ tradeType: "INTRADAY", generatedAt: "not-a-date", now: NOW })).toMatchObject({
      accepted: false,
      reason: "invalid_timestamp",
    });
  });

  it("honors a bounded swing-specific environment override", () => {
    process.env.MIMIR_MAX_SWING_SIGNAL_AGE_MINUTES = "90";
    const result = evaluateSignalFreshness({
      tradeType: "SWING",
      generatedAt: "2026-08-17T08:40:00.000Z",
      now: NOW,
    });
    expect(result).toMatchObject({ accepted: true, ageMinutes: 80, maxAgeMinutes: 90 });
  });
});
