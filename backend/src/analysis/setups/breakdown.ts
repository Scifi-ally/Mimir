import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



// ── Short setup detectors ─────────────────────────────────────────────────────

export function detectBreakdown(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  const last = candles[candles.length - 1]!;
  const recent20Low = Math.min(...candles.slice(-21, -1).map(c => c.low));
  if (last.close >= recent20Low) return null;
  if (last.close > snap.vwap) return null; // Price must be below VWAP for short

  // Reject if already oversold — mean reversion risk
  if (snap.rsi14 < 28) return null;
  // Reject if too extended below EMA20 — late entry
  if (snap.distFromEma20Pct < -10) return null;

  const goodVolume = snap.volumeRatio >= 1.5;
  const strongVolume = snap.volumeRatio >= 2.0;
  const notOversold = snap.rsi14 > 35;
  const downtrend = snap.trend === "DOWN";
  const near52wLow = last.close <= snap.low52w * 1.005;
  const breaking52wLow = last.close < snap.low52w;

  const score = 3.5
    + (goodVolume ? 1.5 : 0)
    + (strongVolume ? 0.5 : 0)
    + (notOversold ? 0.5 : 0)
    + (downtrend ? 1.5 : 0)
    + (snap.adx14 > 25 ? 0.5 : 0)
    + (near52wLow ? 1.0 : 0)
    + (breaking52wLow ? 1.5 : 0)
    + (snap.rsi14 < 48 ? 0.5 : 0);

  const entry = last.close;
  // Stop above swing high
  const swingStop = snap.swingHigh * 1.003;
  // Use SuperTrend trailing stop if valid, else fallback to swing
  const stop = snap.superTrend > entry ? Math.min(swingStop, snap.superTrend) : swingStop;
  const risk = stop - entry;
  if (risk <= 0 || risk > entry * 0.08) return null;
  const target1 = entry - 2 * risk;
  const target2 = entry - 3.5 * risk;
  if (target1 <= 0) return null;
  const rr = (entry - target1) / risk;

  const confluence: string[] = [];
  if (breaking52wLow) confluence.push(`Breaking 52-week low (₹${snap.low52w.toFixed(0)}) — multi-month support breached`);
  else confluence.push(`Breakdown below ${recent20Low.toFixed(0)} (20-day low)`);
  if (strongVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — strong selling conviction`);
  else if (goodVolume) confluence.push(`Volume ${snap.volumeRatio.toFixed(1)}x average — confirmed breakdown`);
  if (downtrend) confluence.push("Price below EMA9 < EMA20 < EMA50 — confirmed downtrend");
  if (snap.adx14 > 25) confluence.push(`ADX ${snap.adx14.toFixed(0)} — strong directional move`);
  confluence.push(`Price below VWAP (₹${snap.vwap.toFixed(2)}) — institutional selling pressure`);
  confluence.push(`Dynamic stop at ₹${stop.toFixed(0)} using SuperTrend/Swing logic`);

  return {
    setupType: "BREAKDOWN", direction: "SELL",
    score: Math.min(score, 10), entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)), target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)), riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}