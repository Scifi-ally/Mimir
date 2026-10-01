/**
 * Trailing-stop ADX gate.
 *
 * WHY. Backtest evidence is consistent on this point: a mechanical trailing
 * stop has positive expectancy only in a trending regime and is a loss machine
 * in chop ("in chop, trailing stops are a guaranteed loss machine - filter with
 * ADX > 20"). A large study over 400 windows / 10 assets / 100 stop values
 * found trailing exits WORSE than a fixed take-profit, and its worst
 * configurations performed worse than exiting at random.
 *
 * This project's setups are momentum/breakout - defined-move patterns, where
 * the literature prefers a fixed target over a trail. So the trail is only
 * engaged when ADX confirms a trend, and otherwise the position is left to the
 * hard target and stop.
 *
 * WHY THIS IS NOT A SILENT DEGRADATION. Before the gate, the trail ratcheted at
 * every whole R: after +1R the stop moved to breakeven, after +2R to +1R. In a
 * chop regime that converts "would have recovered" into "locked at breakeven",
 * which is where the round-trip loss came from. Gating it keeps the protection
 * in trends and removes it where it was subtracting.
 *
 * Measured separately from the breakeven step: the 1R breakeven move itself is
 * EV-safe and is NOT gated. For a 2R target the EV-neutral break-even threshold
 * is 1/(1+2) = 33% of the path to target, and breakeven at +1R is 50%, i.e.
 * later than required. Gating that would remove legitimate risk management.
 */

/** ADX at or above this is treated as trending. Below it, the trail is off. */
export const ADX_TREND_THRESHOLD = 20;

type Candle = { high: number; low: number; close: number };

/**
 * ADX(14) using Wilder's smoothing.
 *
 * Returns null when there is not enough history, rather than a defaulted 0 -
 * an unmeasured trend strength is not the same as "no trend", and the caller
 * treats null as "leave the existing stop alone", which is the safe direction.
 */
export function computeAdx14(candles: Candle[], period = 14): number | null {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;

  let trSum = 0;
  let plusDmSum = 0;
  let minusDmSum = 0;

  // Wilder smoothing over the first `period` bars of true range / directional
  // movement.
  for (let i = 1; i <= period; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;

    trSum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    if (upMove > downMove && upMove > 0) plusDmSum += upMove;
    if (downMove > upMove && downMove > 0) minusDmSum += downMove;
  }

  let dxSum = 0;
  let dxCount = 0;

  for (let i = period + 1; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;

    const tr =
      Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    if (upMove > downMove && upMove > 0) plusDmSum += upMove;
    if (downMove > upMove && downMove > 0) minusDmSum += downMove;
    trSum += tr;

    // Wilder smoothing: each bar contributes 1/period of the recent value.
    trSum = trSum - trSum / period + tr;
    plusDmSum = plusDmSum - plusDmSum / period + (upMove > downMove && upMove > 0 ? upMove : 0);
    minusDmSum = minusDmSum - minusDmSum / period + (downMove > upMove && downMove > 0 ? downMove : 0);

    if (trSum <= 0) continue;
    const plusDi = (100 * plusDmSum) / trSum;
    const minusDi = (100 * minusDmSum) / trSum;
    const denom = plusDi + minusDi;
    if (denom <= 0) continue;
    dxSum += (100 * Math.abs(plusDi - minusDi)) / denom;
    dxCount += 1;
  }

  // The first `period` DX values seed the average; need period of them on top of
  // the initial smoothing window.
  if (dxCount < period) return null;
  return dxSum / period;
}