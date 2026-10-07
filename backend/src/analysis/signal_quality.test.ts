import { describe, it, expect } from "vitest";
import fixture from "../../tests/fixtures/recorded_nse_daily.json";
import type { OHLCV, SetupCandidate } from "./types";
import { replayTrade } from "./trade_replay";
import { relativeStrength60, sectorRelativeStrength60 } from "./relative_strength";
import { assessSignalData } from "./signal_data_quality";
import { quantitativeAdmission, directionalContext } from "./quantitative_admission";
import { cashDeliveryCosts } from "./transaction_costs";

const histories = new Map<string, OHLCV[]>(Object.entries(fixture.bars).map(([s, bars]) => [s, bars.map(b => ({
  timestamp: new Date(b[0]!).toISOString(), open: b[1]!, high: b[2]!, low: b[3]!, close: b[4]!, volume: b[5]!,
}))]));
const recorded = histories.get("RELIANCE")!;
const duplicateAt = recorded.findIndex((c, i) => i > 0 &&
  new Date(Date.parse(c.timestamp) + 5.5 * 3600_000).toISOString().slice(0, 10) ===
  new Date(Date.parse(recorded[i-1]!.timestamp) + 5.5 * 3600_000).toISOString().slice(0, 10));
const candles = duplicateAt < 0 ? recorded : recorded.slice(0, duplicateAt - 1);

describe("signal quality on recorded NSE candles", () => {
  it("rejects old, corrupt and duplicate observations", () => {
    expect(assessSignalData(recorded, new Date("2030-01-01T00:00:00Z"))).toBe("duplicate_daily_session");
    expect(assessSignalData(candles, new Date("2030-01-01T00:00:00Z"))).toBe("stale_daily_candles");
    const duplicate = [...candles, candles.at(-1)!];
    expect(assessSignalData(duplicate, new Date("2030-01-01T00:00:00Z"))).toBe("invalid_candle_timestamps");
    const broken = candles.map(c => ({ ...c })); broken[50]!.high = NaN;
    expect(assessSignalData(broken, new Date("2030-01-01T00:00:00Z"))).toBe("invalid_ohlcv");
  });

  it("uses session close rather than vendor midnight/open timestamps", async () => {
    const { dailyAvailableAt } = await import("./daily_session");
    const last = candles.at(-1)!;
    const close = dailyAvailableAt(last.timestamp);
    expect(close.endsWith("T10:00:00.000Z")).toBe(true);
    expect(assessSignalData(candles, new Date(Date.parse(close) - 1))).toBe("incomplete_daily_session");
  });

  it("matches benchmark sessions and excludes self from sector peers", () => {
    expect(relativeStrength60(candles, candles)).toBeCloseTo(1);
    expect(relativeStrength60(candles, candles.slice(0, -1))).toBeNull();
    const sectors = new Map([["TCS", "IT"], ["INFY", "IT"], ["WIPRO", "IT"]]);
    const stock = histories.get("TCS")!;
    const rs = sectorRelativeStrength60("TCS", "IT", stock, histories, sectors);
    expect(rs).not.toBeNull();
    const stockRatio = stock.at(-1)!.close / stock.at(-61)!.close;
    const peerRatio = ["INFY", "WIPRO"].map(s => histories.get(s)!).map(b => b.at(-1)!.close / b.at(-61)!.close);
    expect(rs).toBeCloseTo(stockRatio / ((peerRatio[0]! + peerRatio[1]!) / 2));
    expect(sectorRelativeStrength60("TCS", "IT", stock, new Map([["TCS", stock]]), sectors)).toBeNull();
  });

  it("requires evidence and treats bearish context as positive for SELL", () => {
    expect(quantitativeAdmission(null, false, false)).toBe("no_validated_quantitative_model");
    expect(quantitativeAdmission(NaN, true, false)).toBe("invalid_quantitative_probability");
    expect(quantitativeAdmission(.7, true, true)).toBe("unmeasured_ranker_features");
    expect(directionalContext(.9, -1, "SELL")).toEqual({ rs: 75, sector: 75 });
  });

  it("never labels a censored horizon, fills outside the range, or omits costs", () => {
    const i = 100, entry = candles[i]!.close;
    const setup: SetupCandidate = { direction: "BUY", setupType: "REPLAY_TEST", score: 0,
      entryPrice: entry, stopLoss: entry * .9, target1: entry * 1.1, target2: entry * 1.2,
      riskReward: 1, reasoning: "", confluence: [] };
    expect(replayTrade(candles, candles.length - 2, setup, 5).outcome).toBe("UNRESOLVED");
    const free = replayTrade(candles, i, setup, 5, 0, 0);
    const paid = replayTrade(candles, i, setup, 5, 5, 5);
    expect(paid.outcome).toBe(free.outcome);
    expect(["WIN", "LOSS", "TIMEOUT"]).toContain(paid.outcome);
    expect(free.retPct - paid.retPct).toBeCloseTo(.1 * (entry + paid.exitFill!) / entry);
    expect(cashDeliveryCosts(entry, entry, 10)).toBeGreaterThan(entry * 10 * .002);
    const unreachable = { ...setup, entryPrice: candles[i+1]!.low / 2,
      stopLoss: candles[i+1]!.low / 4, target1: candles[i+1]!.high * 2 };
    expect(replayTrade(candles, i, unreachable, 1).outcome).toBe("NO_FILL");
  });
});
