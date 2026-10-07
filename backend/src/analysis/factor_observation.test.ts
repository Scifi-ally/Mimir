import { describe, it, expect } from "vitest";
import { observeFactor, refreshFactor } from "./factor_observation";
import { buildMeasuredFactors } from "./measured_factors";

describe("point-in-time factor observations", () => {
  const sourceTime = "2026-10-01T10:00:00Z";
  const now = Date.parse("2026-10-01T11:00:00Z");
  it("does not confuse an observed zero with unavailable data", () => {
    expect(observeFactor(0, "percent", "source", sourceTime, sourceTime, 7200000, now).value).toBe(0);
    expect(observeFactor(null, "percent", "source", null, null, 7200000, now).value).toBeNull();
  });
  it("rejects future publication, invalid numbers, and unknown source time", () => {
    expect(observeFactor(1, "ratio", "source", sourceTime, "2026-10-02T00:00:00Z", 7200000, now).status).toBe("future");
    expect(observeFactor(Infinity, "ratio", "source", sourceTime, sourceTime, 7200000, now).status).toBe("invalid");
    expect(observeFactor(1, "ratio", "source", null, null, 7200000, now).status).toBe("invalid");
  });
  it("expires observations during feed failure without refreshing the source time", () => {
    const original = observeFactor(100, "INR", "source", sourceTime, sourceTime, 7200000, now);
    const stale = refreshFactor(original, now + 7200000);
    expect(stale.status).toBe("stale");
    expect(stale.value).toBeNull();
    expect(original.value).toBe(100);
  });
  it("does not use today's incomplete candle or invent unsupported factors", () => {
    const candles = [
      { timestamp: "2026-09-30T03:45:00Z", open: 100, high: 105, low: 99, close: 104, volume: 1000 },
      { timestamp: "2026-10-01T03:45:00Z", open: 104, high: 150, low: 100, close: 145, volume: 1000 },
    ];
    const snapshot = buildMeasuredFactors("TEST", candles, undefined, {}, new Date("2026-10-01T06:00:00Z"));
    expect(snapshot.factors.close!.value).toBe(104);
    expect(snapshot.factors.news_sentiment!.value).toBeNull();
    expect(snapshot.factors.earnings_surprise!.status).toBe("missing");
    expect(snapshot.predictiveValidation).toBe("not_established");
  });
  it("invalid equity history cannot produce measured prices", () => {
    const candle = { timestamp: "2026-09-30T03:45:00Z", open: 100, high: 99, low: 98, close: 101, volume: 1000 };
    expect(buildMeasuredFactors("TEST", [candle], undefined, {}, new Date(now)).factors.close!.value).toBeNull();
  });
});
