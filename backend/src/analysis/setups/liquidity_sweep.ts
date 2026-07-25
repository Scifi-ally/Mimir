import { OHLCV, TechnicalSnapshot, SetupCandidate } from "../technical";



export function detectLiquiditySweep(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 50) return null;
  const last = candles[candles.length - 1]!;
  
  // Lookback window for structural liquidity (e.g. previous 45 candles, excluding the last 5)
  const lookback = candles.slice(-50, -5);
  const recent = candles.slice(-5);
  
  const swingLow = Math.min(...lookback.map(c => c.low));
  const swingHigh = Math.max(...lookback.map(c => c.high));
  
  let isBullishSweep = false;
  let isBearishSweep = false;
  
  // Bullish Sweep: Price drops below swingLow (sweeps liquidity) but closes back ABOVE it
  for (const c of recent) {
    if (c.low < swingLow && c.close > swingLow) {
      isBullishSweep = true;
    }
  }
  
  // Bearish Sweep: Price goes above swingHigh but closes back BELOW it
  for (const c of recent) {
    if (c.high > swingHigh && c.close < swingHigh) {
      isBearishSweep = true;
    }
  }
  
  if (!isBullishSweep && !isBearishSweep) return null;
  // If both happen, ignore (choppy)
  if (isBullishSweep && isBearishSweep) return null;
  
  const direction = isBullishSweep ? "BUY" : "SELL";
  
  // Must align with momentum
  if (direction === "BUY" && snap.trend === "DOWN") return null;
  if (direction === "SELL" && snap.trend === "UP") return null;
  
  // High volume increases validity
  const baseScore = 8.5; // Sweeps are highly accurate
  const volBoost = snap.volumeRatio > 1.5 ? 1.0 : 0;
  const score = Math.min(10, baseScore + volBoost);
  
  const entry = last.close;
  const stop = direction === "BUY" ? Math.min(...recent.map(c => c.low)) * 0.998 : Math.max(...recent.map(c => c.high)) * 1.002;
  const risk = Math.abs(entry - stop);
  
  if (risk <= 0 || risk > entry * 0.05) return null;
  
  const target1 = direction === "BUY" ? entry + 2.5 * risk : entry - 2.5 * risk;
  const target2 = direction === "BUY" ? entry + 4.0 * risk : entry - 4.0 * risk;
  if (target1 <= 0 || target2 <= 0) return null;
  const rr = Math.abs(target1 - entry) / risk;
  
  const confluence = [
    `Institutional Liquidity Sweep: Price pierced major structural ${direction === "BUY" ? "low" : "high"} and aggressively reclaimed the level`,
    `Stop hunts exhausted, paving way for strong ${direction === "BUY" ? "upward" : "downward"} expansion`
  ];
  
  return {
    setupType: "LIQUIDITY_SWEEP",
    direction,
    score,
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.join(". ") + ".",
    confluence
  };
}