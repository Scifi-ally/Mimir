import type { OHLCV, SetupCandidate } from "./types";
import { cashDeliveryCosts } from "./transaction_costs";
import { dailyAvailableAt, dailySessionDate } from "./daily_session";

export interface ReplayResult {
  outcome: "WIN" | "LOSS" | "TIMEOUT" | "NO_FILL" | "UNRESOLVED" | "INVALID";
  retPct: number;
  resolutionTs?: string;
  fillTs?: string;
  entryFill?: number;
  exitFill?: number;
}

/** Daily-bar limit-entry replay. Unknown intrabar ordering is resolved against
 * the strategy. Costs are estimates, configurable for sensitivity testing;
 * they are never represented as an exact broker tariff. */
export function replayTrade(
  candles: OHLCV[], signalIdx: number, setup: SetupCandidate, holdBars: number,
  feeBpsPerSide: number | undefined = undefined, slippageBpsPerSide = 5,
  notionalInr = 100_000,
): ReplayResult {
  const { entryPrice: entry, stopLoss: stop, target1: target, direction } = setup;
  const sign = direction === "BUY" ? 1 : -1;
  const noFill: ReplayResult = { outcome: "NO_FILL", retPct: 0 };
  if (![entry, stop, target].every(v => Number.isFinite(v) && v > 0) ||
      sign * (entry - stop) <= 0 || sign * (target - entry) <= 0 ||
      !Number.isInteger(signalIdx) || signalIdx < 0 || !Number.isInteger(holdBars) || holdBars < 1 ||
      (feeBpsPerSide !== undefined && (!Number.isFinite(feeBpsPerSide) || feeBpsPerSide < 0)) ||
      !Number.isFinite(notionalInr) || notionalInr <= 0 ||
      !Number.isFinite(slippageBpsPerSide) || slippageBpsPerSide < 0) {
    return { outcome: "INVALID", retPct: 0 };
  }
  // Never label an incomplete holding window as a timeout: it is censored.
  if (signalIdx + holdBars >= candles.length) return { outcome: "UNRESOLVED", retPct: 0 };
  let fillTs: string | undefined;
  // Limit entry cannot be made worse than the limit. Charge entry slippage as
  // an additional execution drag instead of inventing an above-limit fill.
  const quantity = Math.floor(notionalInr / entry);
  if (quantity < 1) return { outcome: "INVALID", retPct: 0 };
  const costPct = (price: number) => {
    const fees = feeBpsPerSide === undefined ? cashDeliveryCosts(entry, price, quantity)
      : (entry + price) * quantity * feeBpsPerSide / 10_000;
    const slippage = (entry + price) * quantity * slippageBpsPerSide / 10_000;
    return (fees + slippage) / (entry * quantity);
  };
  const finish = (outcome: "WIN" | "LOSS" | "TIMEOUT", price: number, ts: string): ReplayResult => ({
    outcome, retPct: (sign * (price - entry) / entry - costPct(price)) * 100,
    resolutionTs: dailyAvailableAt(ts), fillTs, entryFill: entry, exitFill: price,
  });
  for (let i = signalIdx + 1; i <= signalIdx + holdBars; i++) {
    const bar = candles[i]!;
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.low <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close) || bar.volume <= 0 ||
        !Number.isFinite(Date.parse(bar.timestamp)) ||
        dailySessionDate(bar.timestamp) <= dailySessionDate(candles[i - 1]!.timestamp)) return { outcome: "INVALID", retPct: 0 };
    let intrabarEntry = false;
    if (!fillTs) {
      // Expire a setup that opens beyond its stop or target before entry.
      if (sign * (bar.open - stop) <= 0 || sign * (bar.open - target) >= 0) return noFill;
      // An entry outside the complete traded range never traded at that price.
      if (bar.low > entry || bar.high < entry) continue;
      intrabarEntry = sign * (bar.open - entry) > 0;
      fillTs = dailyAvailableAt(bar.timestamp);
    }
    // A stop order gaps at the opening price, never magically at its trigger.
    if (sign * (bar.open - stop) <= 0) return finish("LOSS", bar.open, bar.timestamp);
    const stopHit = sign === 1 ? bar.low <= stop : bar.high >= stop;
    const targetHit = sign === 1 ? bar.high >= target : bar.low <= target;
    if (stopHit) return finish("LOSS", stop, bar.timestamp);
    // The target may have traded BEFORE a later limit entry in this candle.
    if (targetHit && !intrabarEntry) return finish("WIN", target, bar.timestamp);
  }
  if (!fillTs) return noFill;
  const last = candles[signalIdx + holdBars]!;
  return finish("TIMEOUT", last.close, last.timestamp);
}
