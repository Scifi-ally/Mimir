import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  computeATR,
  computeBollingerBands,
  computeEMA,
  computeMACD,
  computeRSI,
  computeVolumeRatio,
  type OHLCV,
} from "./technical";

function candle(i: number, close = 100 + i): OHLCV {
  return {
    timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 500_000 + i * 1_000,
  };
}

describe("technical indicators", () => {
  it("computes EMA with an SMA seed at the period boundary", () => {
    const ema = computeEMA([10, 11, 12, 13, 14], 3);

    expect(ema).toEqual([10, 11, 11, 12, 13]);
  });

  it("returns neutral RSI until enough closes are available", () => {
    expect(computeRSI([100, 101, 102], 14)).toBe(50);
  });

  it("computes RSI for all-up and mixed series", () => {
    expect(computeRSI(Array.from({ length: 16 }, (_, i) => 100 + i), 14)).toBe(100);
    expect(computeRSI([44, 45, 43, 46, 47, 45, 48, 49, 47, 50, 51, 52, 50, 53, 54], 14))
      .toBeGreaterThan(50);
  });

  it("returns 50 for a completely flat series", () => {
    expect(computeRSI(Array.from({ length: 20 }, () => 100), 14)).toBe(50);
  });

  it("seeds ATR from available true ranges for short series", () => {
    const atr = computeATR([
      { ...candle(0), high: 10, low: 8, close: 9 },
      { ...candle(1), high: 13, low: 9, close: 12 },
    ]);

    expect(atr).toBe(4);
  });

  it("computes volume ratio against the previous period", () => {
    const volumes = Array(20).fill(100).concat(250);

    expect(computeVolumeRatio(volumes, 20)).toBe(2.5);
  });

  it("builds a usable snapshot for scanner inputs", () => {
    const candles = Array.from({ length: 260 }, (_, i) => candle(i));
    const snapshot = buildSnapshot(candles);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.trend).toBe("UP");
    expect(snapshot?.avgDailyVolume).toBeGreaterThan(500_000);
  });

  it("keeps MACD and Bollinger output aligned with input length", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 4 + i * 0.2);

    expect(computeMACD(closes)).toHaveLength(closes.length);
    expect(computeBollingerBands(closes)).toHaveLength(closes.length);
  });
});
