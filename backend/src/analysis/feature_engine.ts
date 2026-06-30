/**
 * Feature Engineering Engine — Layer 3
 * ─────────────────────────────────────────────────────────────────────────────
 * For every candidate that passes the technical scanner, compute a structured
 * feature vector. This feeds into the AI Intelligence Layer.
 *
 * Features:
 *   • Technical indicators (RSI, ATR, ADX, VWAP distance, volume ratio)
 *   • EMA distances (20, 50, 200)
 *   • Relative strength (vs Nifty, vs Sector)
 *   • Market context (sector strength, market strength, regime score)
 *   • Composite scores (momentum, trend, volatility, risk-reward)
 */
import type { TechnicalSnapshot, OHLCV } from "./technical";
import { computeATR, computeMACD, computeBollingerBands } from "./technical";
import { getMarketState } from "../market_data/market_state";
import { getLastRegimeOutput } from "./regime_detector";
import { logger } from "../lib/logger";

// ── Feature vector interface ─────────────────────────────────────────────────

export interface FeatureVector {
  symbol: string;
  timestamp: string;

  // Technical indicators
  rsi14: number;
  atr14: number;
  atrPct: number;            // ATR as % of price
  adx14: number;
  volumeRatio: number;       // Current vol / 20d avg vol
  vwapDistance: number;       // Distance from estimated VWAP (%)

  // EMA distances (%)
  ema20Dist: number;
  ema50Dist: number;
  ema200Dist: number;

  // Trend structure
  emaAlignment: number;      // 1 = perfect bullish, -1 = perfect bearish, 0 = mixed
  trendConsistency: number;  // How many of last 10 days closed in trend direction

  // Relative Strength
  rsVsNifty60d: number;      // 1.0 = matching, >1 = outperforming
  rsVsSector60d: number;     // Relative to sector

  // Advanced Technicals (VPVR & VCP)
  pocDistancePct: number;    // Distance from VPVR Point of Control
  bbWidthPct: number;        // Bollinger Band Width %
  vcpContraction: number;    // VCP contraction metric (0-1)

  // Market Context
  sectorStrength: number;    // Sector's current % change
  marketStrength: number;    // Overall market strength (0-100)
  regimeScore: number;       // How favorable is the current regime (0-100)

  // Composite Scores (0-100)
  momentumScore: number;     // RSI + MACD + rate of change
  trendScore: number;        // EMA alignment + ADX + consistency
  volatilityScore: number;   // ATR regime + Bollinger bandwidth
  riskRewardScore: number;   // Normalized RR ratio

  // Price action
  priceRoc5: number;         // 5-day rate of change (%)
  priceRoc10: number;        // 10-day rate of change (%)
  priceRoc20: number;        // 20-day rate of change (%)

  // Candlestick features
  bodyRatio: number;         // body / range of last candle
  upperWickRatio: number;    // upper wick / range
  lowerWickRatio: number;    // lower wick / range
  closeLocation: number;     // where close sits in range (0=low, 1=high)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function rateOfChange(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const old = closes[closes.length - period - 1]!;
  const now = closes[closes.length - 1]!;
  if (old === 0) return 0;
  return ((now - old) / old) * 100;
}

function estimateVWAP(candles: OHLCV[]): number {
  // Approximate VWAP using typical price × volume
  const recent = candles.slice(-20);
  if (recent.length === 0) return 0;
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of recent) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

function computeEMAAlignment(snap: TechnicalSnapshot): number {
  // +1 if perfectly bullish (EMA9 > EMA20 > EMA50 > EMA200)
  // -1 if perfectly bearish
  // 0 if mixed
  let score = 0;
  if (snap.ema9 > snap.ema20) score += 0.33;
  else score -= 0.33;
  if (snap.ema20 > snap.ema50) score += 0.33;
  else score -= 0.33;
  if (snap.ema50 > snap.ema200) score += 0.34;
  else score -= 0.34;
  return Math.round(score * 100) / 100;
}

function computeTrendConsistency(candles: OHLCV[], direction: "UP" | "DOWN" | "SIDEWAYS"): number {
  const last10 = candles.slice(-10);
  if (last10.length === 0) return 50;

  let consistent = 0;
  for (const c of last10) {
    if (direction === "UP" && c.close > c.open) consistent++;
    else if (direction === "DOWN" && c.close < c.open) consistent++;
    else if (direction === "SIDEWAYS") consistent += 0.5; // Neutral
  }
  return (consistent / last10.length) * 100;
}

function computeCandlestickFeatures(candle: OHLCV): {
  bodyRatio: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  closeLocation: number;
} {
  const range = candle.high - candle.low;
  if (range <= 0) return { bodyRatio: 0, upperWickRatio: 0, lowerWickRatio: 0, closeLocation: 0.5 };

  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;

  return {
    bodyRatio: Math.round((body / range) * 100) / 100,
    upperWickRatio: Math.round((upperWick / range) * 100) / 100,
    lowerWickRatio: Math.round((lowerWick / range) * 100) / 100,
    closeLocation: Math.round(((candle.close - candle.low) / range) * 100) / 100,
  };
}

// ── Composite score computations ─────────────────────────────────────────────

function computeMomentumScore(rsi: number, closes: number[]): number {
  // RSI contribution (0-40)
  let score = 0;
  if (rsi >= 50 && rsi <= 70) score += 30 + (rsi - 50) * 0.5; // Sweet spot
  else if (rsi > 70) score += 25; // Overbought but strong
  else if (rsi >= 40) score += 15;
  else score += 5;

  // MACD histogram direction (0-30)
  if (closes.length >= 30) {
    const macd = computeMACD(closes);
    const last = macd[macd.length - 1];
    const prev = macd[macd.length - 2];
    if (last && prev) {
      if (last.histogram > 0 && last.histogram > prev.histogram) score += 30;
      else if (last.histogram > 0) score += 20;
      else if (last.histogram > prev.histogram) score += 10;
    }
  }

  // Rate of change (0-30)
  const roc5 = rateOfChange(closes, 5);
  if (roc5 > 2) score += 30;
  else if (roc5 > 0.5) score += 20;
  else if (roc5 > -0.5) score += 10;

  return clamp(score, 0, 100);
}

function computeTrendScore(snap: TechnicalSnapshot, alignment: number, consistency: number): number {
  let score = 0;

  // EMA alignment (0-35)
  score += (alignment + 1) * 17.5; // -1→0, 0→17.5, +1→35

  // ADX (0-30)
  if (snap.adx14 >= 25 && snap.adx14 <= 45) score += 30;
  else if (snap.adx14 >= 20) score += 20;
  else if (snap.adx14 >= 15) score += 10;

  // Consistency (0-35)
  score += consistency * 0.35;

  return clamp(Math.round(score), 0, 100);
}

function computeVolatilityScore(snap: TechnicalSnapshot, closes: number[]): number {
  const atrPct = snap.close > 0 ? (snap.atr14 / snap.close) * 100 : 0;

  let score = 50;

  // ATR regime: sweet spot is 1-4%
  if (atrPct >= 1 && atrPct <= 4) score += 25;
  else if (atrPct >= 0.6 && atrPct <= 6) score += 10;
  else score -= 15;

  // Bollinger bandwidth
  if (closes.length >= 25) {
    const bb = computeBollingerBands(closes);
    const lastBB = bb[bb.length - 1];
    if (lastBB) {
      // Narrow bandwidth = squeeze = potential for movement
      if (lastBB.bandwidth < 0.06) score += 15;
      else if (lastBB.bandwidth < 0.1) score += 5;
      else if (lastBB.bandwidth > 0.2) score -= 10;
    }
  }

  return clamp(score, 0, 100);
}

function computeRiskRewardScore(rr: number): number {
  // Normalize RR to 0-100 where 3.0 = 100
  if (rr <= 0) return 0;
  if (rr >= 3.0) return 100;
  return Math.round((rr / 3.0) * 100);
}

// ── Main feature computation ─────────────────────────────────────────────────

export function computeFeatureVector(
  symbol: string,
  sector: string,
  candles: OHLCV[],
  snap: TechnicalSnapshot,
  rsVsNifty: number,
  rsVsSector: number,
  riskReward: number,
): FeatureVector {
  const closes = candles.map(c => c.close);
  const lastCandle = candles[candles.length - 1]!;

  // Market context
  const regimeOutput = getLastRegimeOutput();
  const marketState = getMarketState();

  // Sector strength
  const sectorData = marketState.topSectors.find(s => s.name === sector);
  const sectorStrength = sectorData?.changePct ?? 0;

  // VWAP
  const vwap = estimateVWAP(candles);
  const vwapDistance = vwap > 0 ? ((snap.close - vwap) / vwap) * 100 : 0;

  // ATR %
  const atrPct = snap.close > 0 ? (snap.atr14 / snap.close) * 100 : 0;

  // EMA alignment & trend consistency
  const emaAlignment = computeEMAAlignment(snap);
  const trendConsistency = computeTrendConsistency(candles, snap.trend);

  // Candlestick features
  const candleFeatures = computeCandlestickFeatures(lastCandle);

  // Regime score (how favorable is current regime)
  let regimeScore = 50;
  if (regimeOutput) {
    regimeScore = regimeOutput.strength;
  }

  // Market strength
  const marketStrength = regimeOutput?.strength ?? 50;

  // Composite scores
  const momentumScore = computeMomentumScore(snap.rsi14, closes);
  const trendScore = computeTrendScore(snap, emaAlignment, trendConsistency);
  const volatilityScore = computeVolatilityScore(snap, closes);
  const riskRewardScore = computeRiskRewardScore(riskReward);

  // VPVR Point of Control distance
  const pocDistancePct = snap.vpvrPOC > 0
    ? Math.round(((snap.close - snap.vpvrPOC) / snap.vpvrPOC) * 10000) / 100
    : 0;

  // Bollinger Band Width % (squeeze detection)
  let bbWidthPct = 0;
  if (closes.length >= 25) {
    const bb = computeBollingerBands(closes);
    const lastBB = bb[bb.length - 1];
    if (lastBB) {
      bbWidthPct = Math.round(lastBB.bandwidth * 10000) / 100;
    }
  }

  // VCP Contraction: ratio of recent ATR (5-day) vs older ATR (20-day)
  // Values < 1 = contraction (squeeze building), lower = tighter squeeze
  let vcpContraction = 1;
  if (candles.length >= 25) {
    const recentSlice = candles.slice(-8);
    const olderSlice = candles.slice(-25, -5);
    const recentATR = computeATR(recentSlice, Math.min(5, recentSlice.length));
    const olderATR = computeATR(olderSlice, Math.min(14, olderSlice.length));
    vcpContraction = olderATR > 0
      ? Math.round((recentATR / olderATR) * 100) / 100
      : 1;
  }

  const features: FeatureVector = {
    symbol,
    timestamp: new Date().toISOString(),

    // Technical
    rsi14: snap.rsi14,
    atr14: snap.atr14,
    atrPct: Math.round(atrPct * 100) / 100,
    adx14: snap.adx14,
    volumeRatio: snap.volumeRatio,
    vwapDistance: Math.round(vwapDistance * 100) / 100,

    // EMA distances
    ema20Dist: snap.distFromEma20Pct,
    ema50Dist: snap.close > 0 ? Math.round(((snap.close - snap.ema50) / snap.ema50) * 10000) / 100 : 0,
    ema200Dist: snap.close > 0 ? Math.round(((snap.close - snap.ema200) / snap.ema200) * 10000) / 100 : 0,

    // Trend structure
    emaAlignment,
    trendConsistency: Math.round(trendConsistency),

    // Relative strength
    rsVsNifty60d: rsVsNifty,
    rsVsSector60d: rsVsSector,

    // Advanced Technicals (VPVR & VCP)
    pocDistancePct,
    bbWidthPct,
    vcpContraction,

    // Market context
    sectorStrength: Math.round(sectorStrength * 100) / 100,
    marketStrength: Math.round(marketStrength),
    regimeScore: Math.round(regimeScore),

    // Composite scores
    momentumScore: Math.round(momentumScore),
    trendScore: Math.round(trendScore),
    volatilityScore: Math.round(volatilityScore),
    riskRewardScore: Math.round(riskRewardScore),

    // Price action
    priceRoc5: Math.round(rateOfChange(closes, 5) * 100) / 100,
    priceRoc10: Math.round(rateOfChange(closes, 10) * 100) / 100,
    priceRoc20: Math.round(rateOfChange(closes, 20) * 100) / 100,

    // Candlestick
    ...candleFeatures,
  };

  logger.debug({ symbol, momentumScore, trendScore, volatilityScore, riskRewardScore }, "Feature vector computed");
  return features;
}

/**
 * Batch compute feature vectors for multiple candidates.
 */
export function computeFeatureVectors(
  candidates: Array<{
    symbol: string;
    sector: string;
    candles: OHLCV[];
    snap: TechnicalSnapshot;
    rsVsNifty: number;
    rsVsSector: number;
    riskReward: number;
  }>,
): FeatureVector[] {
  return candidates.map(c => computeFeatureVector(
    c.symbol,
    c.sector,
    c.candles,
    c.snap,
    c.rsVsNifty,
    c.rsVsSector,
    c.riskReward,
  ));
}
