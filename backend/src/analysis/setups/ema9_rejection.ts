import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



export function detectEma9Rejection(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 5) return null;
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;

  // Previous close was above EMA9, current close is below — rejection at EMA9
  const rejectedEma9 = prev.close > snap.ema9 && last.close < snap.ema9;
  if (!rejectedEma9) return null;
  if (snap.trend !== "DOWN") return null;

  const nearEma20 = Math.abs(snap.distFromEma20Pct) < 4;
  if (!nearEma20) return null;
  if (snap.distFromEma20Pct < -6) return null;

  const volumeOnRejection = snap.volumeRatio >= 1.2;

  const score = 5
    + (snap.rsi14 > 38 && snap.rsi14 < 55 ? 1.5 : 0)
    + (volumeOnRejection ? 1.5 : 0)
    + (snap.trend === "DOWN" ? 1.5 : 0)
    + (snap.adx14 > 20 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingHigh * 1.003;
  const atrStop = entry + 1.5 * snap.atr14;
  const stop = Math.min(swingStop, atrStop);
  const risk = stop - entry;
  if (risk <= 0) return null;
  const target1 = entry - 2 * risk;
  const target2 = entry - 3 * risk;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;

  const confluence: string[] = [];
  confluence.push(`Rejected at EMA9 (₹${snap.ema9.toFixed(0)}) in downtrend — sellers defending key level`);
  if (volumeOnRejection) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg on rejection — conviction from sellers`);
  if (nearEma20) confluence.push(`Near EMA20 (₹${snap.ema20.toFixed(0)}) — dual resistance above`);

  return {
    setupType: "EMA9_REJECTION", direction: "SELL",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}