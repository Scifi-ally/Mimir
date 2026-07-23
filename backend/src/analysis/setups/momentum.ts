import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



export function detectMomentum(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const aboveAllEmas = last.close > snap.ema9 && last.close > snap.ema20 && last.close > snap.ema50;
  const rsiMomentum = snap.rsi14 >= 55 && snap.rsi14 <= 70;
  const volumeConfirm = snap.volumeRatio >= 1.2;

  if (!aboveAllEmas || !rsiMomentum) return null;
  if (snap.distFromEma20Pct > 8) return null;

  const score = 2.5
    + (volumeConfirm ? 1.5 : 0)
    + (snap.trend === "UP" ? 2 : 0)
    + (snap.adx14 > 25 ? 1.5 : 0)
    + (snap.distFromEma20Pct < 5 ? 1.5 : 0)
    + (last.close > snap.ema200 ? 1.0 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  const emaStop = snap.ema20 - snap.atr14 * 0.3;
  const stop = Math.max(swingStop, emaStop);
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.05) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3.5 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  confluence.push(`Momentum continuation — price above EMA9/20/50 in uptrend`);
  if (rsiMomentum) confluence.push(`RSI ${snap.rsi14.toFixed(0)} — momentum zone, not overbought`);
  if (volumeConfirm) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x avg — buyers active`);
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);

  return {
    setupType: "MOMENTUM_CONTINUATION", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}