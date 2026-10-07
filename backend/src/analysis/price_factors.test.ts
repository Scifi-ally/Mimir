import { describe, expect, it } from "vitest";
import { derivePriceFactors } from "./price_factors";
import { buildMeasuredFactors } from "./measured_factors";

const candles = Array.from({ length: 260 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i, volume: 100000,
}));

describe("direct measured price factors", () => {
  it("does not turn short history into indicator defaults", () => {
    const short = derivePriceFactors(candles.slice(0, 5));
    expect(short.rsi14!.value).toBeNull();
    expect(short.adx14!.value).toBeNull();
    expect(short.volumeRatio!.value).toBeNull();
    expect(short.ema200Dist!.value).toBeNull();
  });
  it("provides real indicators without a model or feature vector", () => {
    const snapshot = buildMeasuredFactors("MEASURED", candles, undefined, {}, new Date("2026-09-19T16:00:00Z"));
    expect(snapshot.factors.rsi14!.value).toBe(100);
    expect(snapshot.factors.volumeRatio!.value).toBe(1);
    expect(snapshot.factors.ema200Dist!.value).toBeGreaterThan(0);
    expect(snapshot.factors.return_252d!.value).toBeCloseTo(100 * (359 / 107 - 1));
    expect(snapshot.factors.rsVsSector60d!.value).toBeNull();
    expect(snapshot.factors.earnings_surprise!.value).toBeNull();
  });
  it("excludes future candles from each derived measurement", () => {
    const now = new Date("2026-09-17T06:00:00Z");
    const changed = candles.map(c => ({ ...c }));
    changed.at(-1)!.close = 100000;
    changed.at(-1)!.high = 100001;
    const a = buildMeasuredFactors("MEASURED", candles, undefined, {}, now);
    const b = buildMeasuredFactors("MEASURED", changed, undefined, {}, now);
    expect(a.factors).toEqual(b.factors);
  });
  it("keeps invalid OHLC unavailable even when a long history exists", () => {
    const changed = candles.map(c => ({ ...c }));
    changed[100]!.low = 10000;
    const result = buildMeasuredFactors("MEASURED", changed, undefined, {}, new Date("2026-09-19T16:00:00Z"));
    expect(result.factors.rsi14!.value).toBeNull();
    expect(result.factors.realizedVol20!.value).toBeNull();
  });
});
