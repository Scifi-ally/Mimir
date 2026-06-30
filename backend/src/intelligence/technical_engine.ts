import { buildSnapshot, type OHLCV } from "../analysis/technical";
import type { CandleBuilderEngine } from "./candle_builder";
import type { CandidateSignal, TechnicalOpportunity } from "./types";

export class TechnicalAnalysisEngine {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly candleBuilder: CandleBuilderEngine,
    private readonly maxSymbols: number,
  ) {}

  analyze(candidate: CandidateSignal): TechnicalOpportunity | null {
    if (!this.active.has(candidate.instrumentKey) && this.active.size >= this.maxSymbols) {
      const oldest = [...this.active.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.active.delete(oldest[0]);
    }
    this.active.set(candidate.instrumentKey, Date.now());

    const candles = this.candleBuilder
      .getCandles(candidate.instrumentKey, "1m")
      .slice(-80)
      .map((c): OHLCV => ({
        timestamp: new Date(c.startTime).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

    const fallback = candidate.state;
    const snap = candles.length >= 20 ? buildSnapshot(candles) : null;
    const atr = snap?.atr14 ?? Math.max(fallback.ltp * 0.006, fallback.high - fallback.low);
    if (fallback.ltp <= 0 || atr <= 0) return null;

    const direction = fallback.percentageChange >= 0 ? "BUY" : "SELL";
    const entry = fallback.ltp;
    const stopLoss =
      direction === "BUY"
        ? Math.max(0.05, entry - atr * 1.2)
        : entry + atr * 1.2;
    const risk = Math.abs(entry - stopLoss);
    const target = direction === "BUY" ? entry + risk * 2 : entry - risk * 2;
    if (risk <= 0 || target <= 0) return null;

    const trendAligned =
      snap == null ||
      (direction === "BUY" ? snap.ema9 >= snap.ema20 : snap.ema9 <= snap.ema20);
    if (!trendAligned && candidate.score < 5.5) return null;

    const score = Math.min(
      10,
      candidate.score + (trendAligned ? 1.2 : -0.6) + (snap?.volumeRatio && snap.volumeRatio > 1.2 ? 0.6 : 0),
    );

    if (score < 5.2) return null;

    return {
      instrumentKey: candidate.instrumentKey,
      symbol: candidate.symbol,
      direction,
      setup: direction === "BUY" ? "LIVE_MOMENTUM_CONTINUATION" : "LIVE_BEAR_MOMENTUM",
      score: Number(score.toFixed(2)),
      entry: Number(entry.toFixed(2)),
      stopLoss: Number(stopLoss.toFixed(2)),
      target: Number(target.toFixed(2)),
      riskReward: 2,
      reasoning: [...candidate.reasons, trendAligned ? "technical trend aligned" : "early momentum candidate"],
      qualifiedAt: Date.now(),
    };
  }

  activeSymbols(): number {
    return this.active.size;
  }
}
