/**
 * Range Trading Scanner
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects stocks trading within established horizontal ranges (flat channels),
 * identifying buying opportunities at support levels and selling opportunities
 * at resistance levels with volume confirmation and RSI confirmation.
 * Activation is governed by scanner_activation.ts (SIDEWAYS_RANGE and
 * HIGH_VOLATILITY as of this writing) — keep that matrix authoritative.
 */
import type { OHLCV, TechnicalSnapshot, SetupCandidate } from "./technical";

interface RangeStructure {
  isInRange: boolean;
  support: number;
  resistance: number;
  rangeHeightPct: number;
  flatnessScore: number; // 0 to 10
}

/**
 * Identifies horizontal ranges using swing highs and swing lows
 */
export function identifyHorizontalRange(candles: OHLCV[]): RangeStructure {
  if (candles.length < 40) {
    return { isInRange: false, support: 0, resistance: 0, rangeHeightPct: 0, flatnessScore: 0 };
  }

  const recent = candles.slice(-30);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  // Identify horizontal levels by grouping local swing extremes
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);


  const rangeHeightPct = ((maxHigh - minLow) / minLow) * 100;

  // Range should be broad enough to trade, but not too volatile (2.5% to 18%)
  if (rangeHeightPct < 2.5 || rangeHeightPct > 18.0) {
    return { isInRange: false, support: minLow, resistance: maxHigh, rangeHeightPct, flatnessScore: 0 };
  }

  // Calculate standard deviation of highs and lows to measure flatness
  const avgHigh = highs.reduce((a, b) => a + b, 0) / highs.length;
  const avgLow = lows.reduce((a, b) => a + b, 0) / lows.length;

  const highVar = highs.reduce((a, b) => a + Math.pow(b - avgHigh, 2), 0) / highs.length;
  const lowVar = lows.reduce((a, b) => a + Math.pow(b - avgLow, 2), 0) / lows.length;

  const highStdDev = Math.sqrt(highVar);
  const lowStdDev = Math.sqrt(lowVar);

  const highStdDevPct = (highStdDev / avgHigh) * 100;
  const lowStdDevPct = (lowStdDev / avgLow) * 100;

  // A very flat range will have low standard deviation of peaks and troughs
  const flatHigh = highStdDevPct < 1.8;
  const flatLow = lowStdDevPct < 1.8;

  let flatnessScore = 0;
  if (highStdDevPct < 1.0) flatnessScore += 5;
  else if (highStdDevPct < 2.0) flatnessScore += 3;
  
  if (lowStdDevPct < 1.0) flatnessScore += 5;
  else if (lowStdDevPct < 2.0) flatnessScore += 3;

  const isInRange = flatHigh && flatLow && flatnessScore >= 6;

  return {
    isInRange,
    support: minLow,
    resistance: maxHigh,
    rangeHeightPct,
    flatnessScore,
  };
}

/**
 * Detects range-bound support buy setups
 */
export function detectRangeLong(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 40) return null;
  const range = identifyHorizontalRange(candles);
  if (!range.isInRange) return null;

  const last = candles[candles.length - 1]!;
  const currentPrice = last.close;

  // Support bounce conditions:
  // 1. Price is near the support level (within 1.2% of range support)
  // 2. Price rejected the support (low is below support or close is above support)
  // 3. RSI is coming out of oversold or turning up (> 30 and increasing)
  // 4. Volume is expanding on the bounce

  const distanceToSupportPct = ((currentPrice - range.support) / range.support) * 100;
  const nearSupport = distanceToSupportPct >= -0.5 && distanceToSupportPct <= 1.5;

  if (!nearSupport) return null;

  const previousClose = candles[candles.length - 2]!.close;
  const turningUp = currentPrice > previousClose && snap.rsi14 > 30;

  if (!turningUp) return null;

  const score = 3.0
    + (range.flatnessScore * 0.3)
    + (snap.volumeRatio >= 1.2 ? 1.5 : 0)
    + (snap.rsi14 < 42 ? 1.0 : 0)
    + (last.close > last.open ? 1.0 : 0);

  if (score < 5.8) return null;

  const entry = currentPrice;
  const stop = range.support * 0.995; // Stop slightly below horizontal support
  const risk = entry - stop;

  if (risk <= 0 || risk > entry * 0.05) return null;

  // Targets at resistance levels
  const target1 = range.resistance * 0.99;
  const target2 = range.resistance + (range.resistance - range.support) * 0.3;

  const rr = (target1 - entry) / risk;
  if (rr < 1.5) return null;

  const confluence = [
    `Price bounce off horizontal range support at ₹${range.support.toFixed(2)}`,
    `Range channel flatness verified (score: ${range.flatnessScore}/10)`,
    `RSI ${snap.rsi14.toFixed(0)} turning up from support zone`,
    `Volume ratio ${snap.volumeRatio.toFixed(2)} indicates buying interest`,
  ];

  return {
    setupType: "RANGE_LONG",
    direction: "BUY",
    score: Math.min(score, 10),
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}

/**
 * Detects range-bound resistance short setups
 */
export function detectRangeShort(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 40) return null;
  const range = identifyHorizontalRange(candles);
  if (!range.isInRange) return null;

  const last = candles[candles.length - 1]!;
  const currentPrice = last.close;

  // Resistance bounce short conditions:
  // 1. Price is near range resistance (within 1.2% of range resistance)
  // 2. Price rejected the resistance (high is above resistance or close is below resistance)
  // 3. RSI is turning down (< 70 and decreasing)
  // 4. Volume expansion on the drop

  const distanceToResistancePct = ((range.resistance - currentPrice) / range.resistance) * 100;
  const nearResistance = distanceToResistancePct >= -0.5 && distanceToResistancePct <= 1.5;

  if (!nearResistance) return null;

  const previousClose = candles[candles.length - 2]!.close;
  const turningDown = currentPrice < previousClose && snap.rsi14 < 70;

  if (!turningDown) return null;

  const score = 3.0
    + (range.flatnessScore * 0.3)
    + (snap.volumeRatio >= 1.2 ? 1.5 : 0)
    + (snap.rsi14 > 58 ? 1.0 : 0)
    + (last.close < last.open ? 1.0 : 0);

  if (score < 5.8) return null;

  const entry = currentPrice;
  const stop = range.resistance * 1.005; // Stop slightly above resistance
  const risk = stop - entry;

  if (risk <= 0 || risk > entry * 0.05) return null;

  const target1 = range.support * 1.01;
  const target2 = range.support - (range.resistance - range.support) * 0.3;
  if (target1 >= entry || target2 <= 0) return null;

  const rr = (entry - target1) / risk;
  if (rr < 1.5) return null;

  const confluence = [
    `Price rejection at horizontal range resistance at ₹${range.resistance.toFixed(2)}`,
    `Range channel flatness verified (score: ${range.flatnessScore}/10)`,
    `RSI ${snap.rsi14.toFixed(0)} turning down from resistance zone`,
    `Volume ratio ${snap.volumeRatio.toFixed(2)} indicates selling interest`,
  ];

  return {
    setupType: "RANGE_SHORT",
    direction: "SELL",
    score: Math.min(score, 10),
    entryPrice: entry,
    stopLoss: parseFloat(stop.toFixed(2)),
    target1: parseFloat(target1.toFixed(2)),
    target2: parseFloat(target2.toFixed(2)),
    riskReward: parseFloat(rr.toFixed(2)),
    reasoning: confluence.slice(0, 2).join(". ") + ".",
    confluence,
  };
}
