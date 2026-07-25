import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";

export function detectMomentumBreakout(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;

  // Aggressive volume requirement
  const volumeSpike = snap.volumeRatio >= 2.5;
  // Price spike > 4%
  const pctChange = ((last.close - prev.close) / prev.close) * 100;
  const priceSpike = pctChange >= 4.0;
  
  // Close near the high (e.g., top 30% of the daily range)
  const range = last.high - last.low;
  const closeNearHigh = range > 0 && (last.high - last.close) / range <= 0.3;

  // We explicitly IGNORE moving averages here to catch sudden explosive turnarounds
  // that traditional indicators might miss.
  if (!volumeSpike || !priceSpike || !closeNearHigh) return null;

  // Since this is an explosive momentum play, we use a wide stop below the current day's low or midpoint
  const midpoint = last.low + (range / 2);
  let stop = Math.min(midpoint, prev.close); // Stop below midpoint or previous close
  
  // Ensure risk isn't too huge
  let risk = last.close - stop;
  if (risk > last.close * 0.08) {
     // Cap risk at 8%
     stop = last.close * 0.92;
     risk = last.close - stop;
  }
  if (risk <= 0) return null;

  const target1 = last.close + 2 * risk;
  const target2 = last.close + 3.5 * risk;
  const rr = (target1 - last.close) / risk;

  const confluence: string[] = [];
  confluence.push(`Explosive momentum: Price up ${pctChange.toFixed(1)}%`);
  confluence.push(`Volume surge: ${snap.volumeRatio.toFixed(1)}x average volume`);
  confluence.push(`Strong close: Finished near highs, indicating sustained buying pressure`);

  return {
    setupType: "MOMENTUM_BREAKOUT",
    direction: "BUY",
    score: 9.0, // High base score due to explosive nature
    entryPrice: last.close,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: `Sudden explosive volume and price spike, completely overpowering any overhead resistance.`,
    confluence,
  };
}
