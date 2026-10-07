import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/recorded_nse_daily.json";
import { replayTrade } from "./trade_replay";
import type { OHLCV, SetupCandidate } from "./types";

describe("recorded daily trade replay", () => {
  it("rejects a recorded flat zero-volume WIPRO bar as an executable fill", () => {
    const candles: OHLCV[] = fixture.bars.WIPRO.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp: new Date(timestamp).toISOString(), open, high, low, close, volume,
    }));
    const zeroVolumeIdx = candles.findIndex((c) => c.volume === 0 && c.open === c.high && c.high === c.low && c.low === c.close);
    expect(zeroVolumeIdx).toBeGreaterThan(0);
    expect(zeroVolumeIdx + 1).toBeLessThan(candles.length);
    const flat = candles[zeroVolumeIdx]!;
    const setup: SetupCandidate = {
      setupType: "recorded-zero-volume-regression", direction: "BUY", score: 0,
      entryPrice: flat.close, stopLoss: flat.close * 0.99, target1: flat.close * 1.01,
      target2: flat.close * 1.02, riskReward: 1, reasoning: "recorded bar regression", confluence: [],
    };

    const result = replayTrade(candles, zeroVolumeIdx - 1, setup, 1);
    expect(result.outcome).toBe("INVALID");
    expect(result.retPct).toBe(0);
  });
});
