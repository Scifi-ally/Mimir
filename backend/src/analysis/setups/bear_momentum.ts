import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



export function detectBearMomentum(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const belowAllEmas = last.close < snap.ema9 && last.close < snap.ema20 && last.close < snap.ema50;
  const rsiBearZone = snap.rsi14 >= 28 && snap.rsi14 <= 46;
  const volumeConfirm = snap.volumeRatio >= 1.2;

  if (!belowAllEmas || !rsiBearZone) return null;
  if (snap.distFromEma20Pct < -8) return null;
  if (last.close > snap.vwap) return null; // Reject if above VWAP

  const score = 2.5
    + (volumeConfirm ? 1.5 : 0)
    + (snap.trend === "DOWN" ? 2 : 0)
    + (snap.adx14 > 25 ? 1.5 : 0)
    + (snap.distFromEma20Pct > -5 ? 1.5 : 0)
    + (last.close < snap.ema200 ? 1.0 : 0);

  const entry = last.close;
  const swingStop = snap.swingHigh * 1.003;
  const stop = snap.superTrend > entry ? Math.min(swingStop, snap.superTrend) : swingStop;
  const risk = stop - entry;
  if (risk <= 0 || risk > entry * 0.05) return null;
  const target1 = entry - 2 * risk;
  const target2 = entry - 3.5 * risk;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;

  const confluence: string[] = [];
  confluence.push(`Bear momentum — price below EMA9/20/50 in downtrend`);
  if (rsiBearZone) confluence.push(`RSI ${snap.rsi14.toFixed(0)} — bearish momentum zone, not oversold`);
  if (volumeConfirm) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg — sellers active`);
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);
  confluence.push(`Price remaining below VWAP (₹${snap.vwap.toFixed(2)})`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)}`);

  return {
    setupType: "BEAR_MOMENTUM", direction: "SELL",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}