import { describe, it, expect } from "vitest";
import { computeAdx14, ADX_TREND_THRESHOLD } from "./adx_gate";

type Candle = { high: number; low: number; close: number };

/** Deterministic synthetic tape; no randomness, so the ADX is reproducible. */
function series(prices: number[]): Candle[] {
  return prices.map((p) => ({
    high: p + 1,
    low: p - 1,
    close: p,
  }));
}

function trend(n: number, from = 100, step = 1.5): Candle[] {
  return series(Array.from({ length: n }, (_, i) => from + i * step));
}

function chop(n: number): Candle[] {
  // Alternating up/down with no net drift: high ADX should NOT come out.
  return series(Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)));
}

describe("computeAdx14", () => {
  it("returns null rather than a defaulted 0 when history is too short", () => {
    // Critical: null means "unmeasured", which leaves the stop alone. A 0 would
    // read as "no trend" and silently disable the trail on old data.
    expect(computeAdx14(series([100, 101, 102]))).toBeNull();
    expect(computeAdx14([])).toBeNull();
    expect(computeAdx14(series(Array(28).fill(100)))).toBeNull();
  });

  it("reads high ADX on a clean sustained trend", () => {
    const adx = computeAdx14(trend(120));
    expect(adx).not.toBeNull();
    expect(adx!).toBeGreaterThan(ADX_TREND_THRESHOLD);
  });

  it("reads lower ADX on an alternating range-bound tape", () => {
    const trending = computeAdx14(trend(120))!;
    const ranging = computeAdx14(chop(120))!;
    expect(ranging).toBeLessThan(trending);
  });

  it("never returns NaN or Infinity for a flat tape", () => {
    const adx = computeAdx14(series(Array(80).fill(100)));
    if (adx !== null) {
      expect(Number.isFinite(adx)).toBe(true);
      expect(adx).toBeGreaterThanOrEqual(0);
      expect(adx).toBeLessThanOrEqual(100);
    }
  });

  it("stays inside [0,100] on a noisy tape", () => {
    const noisy: Candle[] = Array.from({ length: 150 }, (_, i) => {
      const wobble = ((i * 37) % 11) - 5;
      return { high: 100 + wobble + 2, low: 100 + wobble - 2, close: 100 + wobble };
    });
    const adx = computeAdx14(noisy);
    if (adx !== null) {
      expect(adx).toBeGreaterThanOrEqual(0);
      expect(adx).toBeLessThanOrEqual(100);
    }
  });

  it("handles a downtrend symmetrically to an uptrend", () => {
    const up = computeAdx14(trend(120))!;
    const down = computeAdx14(
      series(Array.from({ length: 120 }, (_, i) => 100 - i * 1.5)),
    )!;
    expect(down).toBeGreaterThan(ADX_TREND_THRESHOLD);
    expect(Math.abs(down - up)).toBeLessThan(1.5);
  });
});