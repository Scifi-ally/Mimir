import { OHLCV, TechnicalSnapshot, SetupCandidate, computeMACD } from "../technical";



// ── Advanced Setup Detectors ─────────────────────────────────────────────────

export function detectMacdCrossover(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 35) return null;
  const closes = candles.map(c => c.close);
  const macdResults = computeMACD(closes);
  const lastIdx = candles.length - 1;
  const last = macdResults[lastIdx]!;
  const prev = macdResults[lastIdx - 1]!;

  const bullishCross = prev.macd <= prev.signal && last.macd > last.signal;
  const bearishCross = prev.macd >= prev.signal && last.macd < last.signal;

  if (!bullishCross && !bearishCross) return null;

  const entry = candles[lastIdx]!.close;
  const direction = bullishCross ? "BUY" : "SELL";

  // Check trend alignment
  if (direction === "BUY" && snap.trend !== "UP") return null;
  if (direction === "SELL" && snap.trend !== "DOWN") return null;

  const baseScore = 6.8;
  const rsiFilter = direction === "BUY" ? (snap.rsi14 < 68 ? 1.0 : 0) : (snap.rsi14 > 32 ? 1.0 : 0);
  const volFilter = snap.volumeRatio > 1.2 ? 0.7 : 0;
  const score = Math.min(10, baseScore + rsiFilter + volFilter);

  const swingStop = direction === "BUY" ? snap.swingLow * 0.997 : snap.swingHigh * 1.003;
  const atrStop = direction === "BUY" ? entry - 1.8 * snap.atr14 : entry + 1.8 * snap.atr14;
  const stop = direction === "BUY" ? Math.max(swingStop, atrStop) : Math.min(swingStop, atrStop);
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || risk > entry * 0.07) return null;

  const target1 = direction === "BUY" ? entry + 2.0 * risk : entry - 2.0 * risk;
  const target2 = direction === "BUY" ? entry + 3.0 * risk : entry - 3.0 * risk;
  if (target1 <= 0) return null;
  const rr = Math.abs(target1 - entry) / risk;

  const confluence = [
    `MACD Crossover: MACD line crossed ${direction === "BUY" ? "above" : "below"} Signal line on ${snap.trend.toLowerCase()}trend`,
    `RSI is in healthy zone at ${snap.rsi14.toFixed(0)}`,
  ];

  return {
    setupType: "MACD_CROSSOVER",
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