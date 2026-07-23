import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



export function detectEma9Reclaim(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;

  const reclaimedEma9 = prev.close < snap.ema9 && last.close > snap.ema9;
  if (!reclaimedEma9) return null;
  if (snap.trend !== "UP") return null;

  const nearEma20 = Math.abs(snap.distFromEma20Pct) < 4;
  if (!nearEma20) return null;
  if (snap.distFromEma20Pct > 6) return null;

  const volumeOnReclaim = snap.volumeRatio >= 1.2;

  const score = 5
    + (snap.rsi14 > 45 && snap.rsi14 < 62 ? 1.5 : 0)
    + (volumeOnReclaim ? 1.5 : 0)
    + (snap.trend === "UP" ? 1.5 : 0)
    + (snap.adx14 > 20 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  const atrStop = entry - 1.5 * snap.atr14;
  const stop = Math.max(swingStop, atrStop);
  const risk = entry - stop;
  if (risk <= 0) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  confluence.push(`Reclaimed EMA9 (₹${snap.ema9.toFixed(0)}) after pullback — buyers re-entering at key level`);
  if (volumeOnReclaim) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg on reclaim — conviction behind the move`);
  if (nearEma20) confluence.push(`Near EMA20 (₹${snap.ema20.toFixed(0)}) — double support below entry`);

  return {
    setupType: "EMA9_RECLAIM", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}