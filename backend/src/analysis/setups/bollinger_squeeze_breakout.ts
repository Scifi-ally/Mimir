import { OHLCV, TechnicalSnapshot, SetupCandidate, computeBollingerBands } from "../technical";



export function detectBollingerSqueezeBreakout(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 40) return null;
  const closes = candles.map(c => c.close);
  const bb = computeBollingerBands(closes);
  const lastIdx = candles.length - 1;
  const last = bb[lastIdx]!;
  const prev = bb[lastIdx - 1]!;

  // Squeeze detection: look at bandwidth over the last 15 periods (excluding today)
  const bandwidthHistory = bb.slice(-16, -1).map(b => b.bandwidth);
  const avgBandwidth = bandwidthHistory.reduce((a, b) => a + b, 0) / bandwidthHistory.length;

  // A squeeze is active if bandwidth is narrow and was contracting
  const isSqueezed = last.bandwidth < 0.08 || last.bandwidth < avgBandwidth * 0.90;
  if (!isSqueezed) return null;

  const entry = candles[lastIdx]!.close;
  const prevClose = candles[lastIdx - 1]!.close;

  const upperBreakout = prevClose <= prev.upper && entry > last.upper;
  const lowerBreakdown = prevClose >= prev.lower && entry < last.lower;

  if (!upperBreakout && !lowerBreakdown) return null;

  const direction = upperBreakout ? "BUY" : "SELL";

  // Squeezes require high volume to confirm breakout
  if (snap.volumeRatio < 1.4) return null;

  const baseScore = 7.2;
  const strongVolume = snap.volumeRatio >= 2.0 ? 1.0 : 0.5;
  const adxBoost = snap.adx14 > 22 ? 0.6 : 0;
  const score = Math.min(10, baseScore + strongVolume + adxBoost);

  const swingStop = direction === "BUY" ? snap.swingLow * 0.997 : snap.swingHigh * 1.003;
  const bandStop = direction === "BUY" ? last.middle * 0.998 : last.middle * 1.002;
  const stop = direction === "BUY" ? Math.max(swingStop, bandStop) : Math.min(swingStop, bandStop);
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || risk > entry * 0.075) return null;

  const target1 = direction === "BUY" ? entry + 2.0 * risk : entry - 2.0 * risk;
  const target2 = direction === "BUY" ? entry + 3.2 * risk : entry - 3.2 * risk;
  if (target1 <= 0) return null;
  const rr = Math.abs(target1 - entry) / risk;

  const confluence = [
    `Bollinger Squeeze Breakout: Price broke ${direction === "BUY" ? "above Upper" : "below Lower"} Band after period of low volatility`,
    `Volume expansion confirmed with ${snap.volumeRatio.toFixed(1)}x average volume`,
  ];

  return {
    setupType: "BOLLINGER_SQUEEZE_BREAKOUT",
    direction,
    score,
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.join(". ") + ".",
    confluence,
  };
}