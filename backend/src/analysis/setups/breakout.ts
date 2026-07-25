import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



// ── Long setup detectors ──────────────────────────────────────────────────────

export function detectBreakout(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const recent20High = Math.max(...candles.slice(-21, -1).map(c => c.high));
  if (last.close <= recent20High) return null;
  if (snap.distFromEma20Pct > 10) return null;
  if (last.close < snap.vwap) return null; // Reject long if below VWAP

  const goodVolume = snap.volumeRatio >= 1.5;
  const strongVolume = snap.volumeRatio >= 2.0;
  const notOverbought = snap.rsi14 < 72;
  const trending = snap.trend === "UP";
  const near52wHigh = last.close >= snap.high52w * 0.995;
  const breaking52wHigh = last.close > snap.high52w;
  const momentumConfirm = snap.adx14 > 20;

  // Stricter Filter: Breakouts must have strong momentum or exceptionally good volume
  if (!momentumConfirm && !strongVolume) return null;

  const score = 3.5
    + (goodVolume ? 1.5 : 0)
    + (strongVolume ? 0.5 : 0)
    + (notOverbought ? 0.5 : 0)
    + (trending ? 1.5 : 0)
    + (snap.adx14 > 25 ? 0.5 : 0)
    + (near52wHigh ? 1.0 : 0)
    + (breaking52wHigh ? 1.5 : 0)
    + (snap.rsi14 > 55 ? 0.5 : 0);

  const entry = last.close;
  const swingStop = snap.swingLow * 0.997;
  // Use SuperTrend for dynamic trailing stop if valid, else fallback to swing
  const stop = snap.superTrend < entry ? Math.max(swingStop, snap.superTrend) : swingStop;
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.08) return null;
  const target1 = entry + 2 * risk;
  const target2 = entry + 3.5 * risk;
  const rr = (target1 - entry) / risk;

  const confluence: string[] = [];
  if (breaking52wHigh) confluence.push(`Breaking 52-week high (₹${snap.high52w.toFixed(0)}) — multi-month resistance cleared`);
  else confluence.push(`Breakout above ${recent20High.toFixed(0)} (20-day high)`);
  if (strongVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — very strong conviction`);
  else if (goodVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — confirmed breakout`);
  if (trending) confluence.push("Price above EMA9 > EMA20 > EMA50 — confirmed uptrend");
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);
  confluence.push(`Price above VWAP (₹${snap.vwap.toFixed(2)}) — institutional trend alignment`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)} using SuperTrend/Swing logic`);

  return {
    setupType: "BREAKOUT", direction: "BUY",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}