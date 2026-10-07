import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ flows: vi.fn(), historical: vi.fn() }));
vi.mock("../../db/src", () => ({ db: { select: () => ({ from: () => ({ orderBy: () => ({ limit: mocks.flows }) }) }) } }));
vi.mock("../lib/yahoo-client", () => ({ yahooFinance: { historical: mocks.historical } }));
import { computeFiiDiiDivergence, getFiiDiiDivergence, resetDivergenceCache, computeCvdFromCandles } from "./divergence_engine";
const days = ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T12:00:00Z")); vi.resetAllMocks();
  resetDivergenceCache();
  mocks.flows.mockResolvedValue(days.slice(1).reverse().map(date => ({ date, fiiNet: 500, diiNet: 0 })));
  mocks.historical.mockResolvedValue(days.map((date, i) => ({ date: new Date(date), close: 20000 - i * 100 })));
});
afterEach(() => vi.useRealTimers());
describe("dated FII/DII divergence", () => {
  it("expires cached measurements and recovers from a temporary missing source", async () => {
    mocks.flows.mockResolvedValueOnce([]);
    expect((await getFiiDiiDivergence()).available).toBe(false);
    expect((await getFiiDiiDivergence()).available).toBe(false);
    expect(mocks.flows).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-04T12:16:00Z"));
    expect((await getFiiDiiDivergence()).available).toBe(true);
    expect(mocks.flows).toHaveBeenCalledTimes(2);
  });
  it("measures five intervals over the same five flow sessions", async () => {
    const result = await computeFiiDiiDivergence();
    expect(result.available).toBe(true);
    expect(result.niftyReturn5d).toBeCloseTo(-2.5);
    expect(result.totalFlow5d).toBe(2500);
    expect(result.divergenceType).toBe("BULLISH");
  });
  it("keeps unknown flows null", async () => {
    mocks.flows.mockResolvedValue([]);
    const result = await computeFiiDiiDivergence();
    expect(result.available).toBe(false);
    expect(result.totalFlow5d).toBeNull();
    expect(result.penaltyOrBoost).toBeNull();
  });
  it("rejects a price window that does not align with the recorded flows", async () => {
    mocks.historical.mockResolvedValue(days.slice(1).map(date => ({ date: new Date(date), close: 20000 })));
    const result = await computeFiiDiiDivergence();
    expect(result.available).toBe(false);
    expect(result.niftyReturn5d).toBeNull();
    expect(result.totalFlow5d).toBe(2500);
  });
  it("does not reuse stale flow totals as current measurements", async () => {
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    expect((await computeFiiDiiDivergence()).totalFlow5d).toBeNull();
  });
});

describe("CVD (Cumulative Volume Delta) divergence engine", () => {
  it("rejects fewer than 5 candles as unavailable", () => {
    const res = computeCvdFromCandles([{ open: 100, high: 105, low: 95, close: 102, volume: 1000 }]);
    expect(res.available).toBe(false);
    expect(res.isDiverging).toBe(false);
    expect(res.divergenceType).toBe("NEUTRAL");
  });

  it("detects regular bullish absorption divergence when price drops but CVD rises", () => {
    // Generate 15 candles where price is declining from 200 to 180, but delta is strongly positive (buying at lows)
    const candles = Array.from({ length: 15 }, (_, i) => {
      const base = 200 - i * 1.5;
      return {
        open: base,
        low: base - 2,
        high: base + 1,
        // Close near the high of the bar with high volume => strong positive delta
        close: base + 0.9,
        volume: 50000,
      };
    });

    const res = computeCvdFromCandles(candles, "NIFTY 50", "15m");
    expect(res.available).toBe(true);
    expect(res.isDiverging).toBe(true);
    expect(res.divergenceType).toBe("BULLISH_ABSORPTION");
    expect(res.signal).toBe("BULLISH");
    expect(res.penaltyOrBoost).toBeGreaterThan(0);
    expect(res.priceSlope).toBe("FALLING");
    expect(res.cvdSlope).toBe("RISING");
  });

  it("detects regular bearish exhaustion divergence when price rallies but CVD drops", () => {
    // Generate 15 candles where price is rallying from 180 to 200, but delta is negative (selling into highs)
    const candles = Array.from({ length: 15 }, (_, i) => {
      const base = 180 + i * 1.5;
      return {
        open: base,
        low: base - 1,
        high: base + 2,
        // Close near the low of the bar with high volume => strong negative delta
        close: base - 0.9,
        volume: 50000,
      };
    });

    const res = computeCvdFromCandles(candles, "NIFTY 50", "15m");
    expect(res.available).toBe(true);
    expect(res.isDiverging).toBe(true);
    expect(res.divergenceType).toBe("BEARISH_EXHAUSTION");
    expect(res.signal).toBe("BEARISH");
    expect(res.penaltyOrBoost).toBeLessThan(0);
    expect(res.priceSlope).toBe("RISING");
    expect(res.cvdSlope).toBe("FALLING");
  });

  it("reports neutral when price and CVD move harmoniously in the same direction", () => {
    // Upward price with strong positive volume delta (normal healthy rally)
    const candles = Array.from({ length: 15 }, (_, i) => {
      const base = 100 + i * 2;
      return {
        open: base,
        low: base - 0.5,
        high: base + 3,
        close: base + 2.8,
        volume: 10000,
      };
    });

    const res = computeCvdFromCandles(candles, "NIFTY 50", "15m");
    expect(res.available).toBe(true);
    expect(res.isDiverging).toBe(false);
    expect(res.divergenceType).toBe("NEUTRAL");
    expect(res.signal).toBe("NEUTRAL");
    expect(res.penaltyOrBoost).toBe(0);
  });
});

