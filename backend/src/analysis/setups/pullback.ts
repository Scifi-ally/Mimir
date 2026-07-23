import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



export function detectPullback(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  if (snap.trend !== "UP") return null;

  const nearEma20 = snap.distFromEma20Pct >= -1.5 && snap.distFromEma20Pct <= 1.5;
  const rsiHealthy = snap.rsi14 >= 38 && snap.rsi14 <= 58;
  const aboveEma50 = last.close > snap.ema50;
  const quietPullback = snap.volumeRatio < 0.85;

  if (!nearEma20 || !aboveEma50) return null;
  if (snap.distFromEma20Pct > 5) return null;
  if (last.close < snap.vwap) return null; // VWAP must hold for long pullbacks

  const score = 3.5
    + (rsiHealthy ? 1.5 : 0)
    + (quietPullback ? 1.5 : 0)
    + (snap.adx14 > 20 ? 1.0 : 0)
    + (snap.trend === "UP" ? 1.5 : 0)
    + (last.close > snap.ema9 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  const stop = snap.superTrend < entry ? Math.max(swingStop, snap.superTrend) : swingStop;
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.08) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  confluence.push(`Pullback to EMA20 (₹${snap.ema20.toFixed(0)}) in established uptrend`);
  if (rsiHealthy) confluence.push(`RSI ${snap.rsi14.toFixed(0)} — healthy correction, momentum intact`);
  if (aboveEma50) confluence.push(`Price held above EMA50 — trend structure intact`);
  if (quietPullback) confluence.push(`Low-volume pullback (${snap.volumeRatio.toFixed(2)}x avg) — sellers not in control`);
  confluence.push(`Supported above VWAP (₹${snap.vwap.toFixed(2)})`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)}`);

  return {
    setupType: "PULLBACK", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}