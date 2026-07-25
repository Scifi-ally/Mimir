/**
 * Mean Reversion Scanner
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects stocks at support/resistance extremes of their range with
 * RSI divergence, Bollinger Band extremes, and mean-reversion signals.
 * Activation is governed by scanner_activation.ts (SIDEWAYS_RANGE,
 * BEARISH_STEADY and HIGH_VOLATILITY as of this writing).
 */
import type { OHLCV, TechnicalSnapshot, SetupCandidate } from "./technical";
import { computeRSI, computeBollingerBands } from "./technical";

export function detectMeanReversionLong(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 40) return null;
  const last = candles[candles.length - 1]!;
  const closes = candles.map(c => c.close);

  // Conditions for mean-reversion long:
  // 1. Price at or below lower Bollinger Band
  // 2. RSI oversold (< 35)
  // 3. Price near EMA50 support or below
  // 4. Not in strong downtrend (avoid catching knives)

  const bb = computeBollingerBands(closes);
  const lastBB = bb[bb.length - 1]!;

  const atLowerBand = last.close <= lastBB.lower * 1.01;
  const rsiOversold = snap.rsi14 < 35;
  const nearEma50 = Math.abs(((last.close - snap.ema50) / snap.ema50) * 100) < 3;
  const notStrongDowntrend = snap.trend !== "DOWN" || snap.adx14 < 25;

  if (!atLowerBand && !rsiOversold) return null;
  if (!notStrongDowntrend) return null;

  // Check for bullish divergence (price making lower low but RSI making higher low)
  const hasDivergence = detectBullishDivergence(candles, closes);

  const score = 3.0
    + (atLowerBand ? 2.0 : 0)
    + (rsiOversold ? 1.5 : 0)
    + (nearEma50 ? 1.0 : 0)
    + (hasDivergence ? 2.0 : 0)
    + (snap.volumeRatio >= 1.3 ? 0.5 : 0);

  if (score < 5.5) return null;

  const entry = last.close;
  // Stop below recent swing low
  const recentLows = candles.slice(-15).map(c => c.low);
  const swingLow = Math.min(...recentLows);
  const stop = swingLow * 0.997;
  const risk = entry - stop;
  if (risk <= 0 || risk > entry * 0.06) return null;

  // Target: back to middle Bollinger Band (mean)
  const target1 = lastBB.middle;
  const target2 = lastBB.middle + (lastBB.middle - lastBB.lower) * 0.5;
  if (target1 <= entry) return null;

  const rr = (target1 - entry) / risk;
  if (rr < 1.5) return null;

  const confluence: string[] = [];
  if (atLowerBand) confluence.push(`Price at lower Bollinger Band (₹${lastBB.lower.toFixed(0)}) — statistical extreme`);
  if (rsiOversold) confluence.push(`RSI ${snap.rsi14.toFixed(0)} oversold — mean reversion likely`);
  if (hasDivergence) confluence.push("Bullish RSI divergence detected — selling pressure fading");
  if (nearEma50) confluence.push(`Near EMA50 support (₹${snap.ema50.toFixed(0)})`);
  confluence.push(`Target: mean reversion to ₹${target1.toFixed(0)} (middle BB)`);

  return {
    setupType: "MEAN_REVERSION_LONG",
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

export function detectMeanReversionShort(candles: OHLCV[], snap: TechnicalSnapshot): SetupCandidate | null {
  if (candles.length < 40) return null;
  const last = candles[candles.length - 1]!;
  const closes = candles.map(c => c.close);

  const bb = computeBollingerBands(closes);
  const lastBB = bb[bb.length - 1]!;

  const atUpperBand = last.close >= lastBB.upper * 0.99;
  const rsiOverbought = snap.rsi14 > 65;
  const notStrongUptrend = snap.trend !== "UP" || snap.adx14 < 25;

  if (!atUpperBand && !rsiOverbought) return null;
  if (!notStrongUptrend) return null;

  const hasDivergence = detectBearishDivergence(candles, closes);

  const score = 3.0
    + (atUpperBand ? 2.0 : 0)
    + (rsiOverbought ? 1.5 : 0)
    + (hasDivergence ? 2.0 : 0)
    + (snap.volumeRatio >= 1.3 ? 0.5 : 0);

  if (score < 5.5) return null;

  const entry = last.close;
  const recentHighs = candles.slice(-15).map(c => c.high);
  const swingHigh = Math.max(...recentHighs);
  const stop = swingHigh * 1.003;
  const risk = stop - entry;
  if (risk <= 0 || risk > entry * 0.06) return null;

  const target1 = lastBB.middle;
  const target2 = lastBB.middle - (lastBB.upper - lastBB.middle) * 0.5;
  if (target1 >= entry || target2 <= 0) return null;

  const rr = (entry - target1) / risk;
  if (rr < 1.5) return null;

  const confluence: string[] = [];
  if (atUpperBand) confluence.push(`Price at upper Bollinger Band (₹${lastBB.upper.toFixed(0)}) — statistical extreme`);
  if (rsiOverbought) confluence.push(`RSI ${snap.rsi14.toFixed(0)} overbought — mean reversion likely`);
  if (hasDivergence) confluence.push("Bearish RSI divergence — buying pressure fading");
  confluence.push(`Target: mean reversion to ₹${target1.toFixed(0)} (middle BB)`);

  return {
    setupType: "MEAN_REVERSION_SHORT",
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

// ── Divergence detection helpers ─────────────────────────────────────────────

function detectBullishDivergence(candles: OHLCV[], closes: number[]): boolean {
  if (candles.length < 20) return false;
  // Check if price made lower low but RSI made higher low in last 10-20 candles
  const recent = candles.slice(-20);

  let priceLow1 = Infinity, priceLow1Idx = -1;
  let priceLow2 = Infinity, priceLow2Idx = -1;

  // Find two swing lows
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i]!.low < recent[i - 1]!.low && recent[i]!.low < recent[i + 1]!.low) {
      if (recent[i]!.low < priceLow1) {
        priceLow2 = priceLow1;
        priceLow2Idx = priceLow1Idx;
        priceLow1 = recent[i]!.low;
        priceLow1Idx = i;
      } else if (recent[i]!.low < priceLow2) {
        priceLow2 = recent[i]!.low;
        priceLow2Idx = i;
      }
    }
  }

  if (priceLow1Idx < 0 || priceLow2Idx < 0) return false;
  if (Math.abs(priceLow1Idx - priceLow2Idx) < 3) return false;

  // Check RSI at those points. Index into the FULL closes series: slicing only
  // the 20-bar window gives computeRSI < 15 closes for early swings, and it
  // returns a hardcoded neutral 50 — fabricating divergences against a real
  // RSI at the other swing. Callers guarantee candles.length >= 40.
  const offset = closes.length - recent.length;
  const rsi1 = computeRSI(closes.slice(0, offset + priceLow1Idx + 1), 14);
  const rsi2 = computeRSI(closes.slice(0, offset + priceLow2Idx + 1), 14);

  // Price lower low + RSI higher low = bullish divergence
  const earlierPrice = priceLow1Idx < priceLow2Idx ? priceLow1 : priceLow2;
  const laterPrice = priceLow1Idx < priceLow2Idx ? priceLow2 : priceLow1;
  const earlierRsi = priceLow1Idx < priceLow2Idx ? rsi1 : rsi2;
  const laterRsi = priceLow1Idx < priceLow2Idx ? rsi2 : rsi1;

  return laterPrice < earlierPrice && laterRsi > earlierRsi;
}

function detectBearishDivergence(candles: OHLCV[], closes: number[]): boolean {
  if (candles.length < 20) return false;
  const recent = candles.slice(-20);

  let priceHigh1 = -Infinity, priceHigh1Idx = -1;
  let priceHigh2 = -Infinity, priceHigh2Idx = -1;

  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i]!.high > recent[i - 1]!.high && recent[i]!.high > recent[i + 1]!.high) {
      if (recent[i]!.high > priceHigh1) {
        priceHigh2 = priceHigh1;
        priceHigh2Idx = priceHigh1Idx;
        priceHigh1 = recent[i]!.high;
        priceHigh1Idx = i;
      } else if (recent[i]!.high > priceHigh2) {
        priceHigh2 = recent[i]!.high;
        priceHigh2Idx = i;
      }
    }
  }

  if (priceHigh1Idx < 0 || priceHigh2Idx < 0) return false;
  if (Math.abs(priceHigh1Idx - priceHigh2Idx) < 3) return false;

  // Full-series RSI — see detectBullishDivergence for why the 20-bar slice
  // fabricated neutral RSI=50 at early swings.
  const offset = closes.length - recent.length;
  const rsi1 = computeRSI(closes.slice(0, offset + priceHigh1Idx + 1), 14);
  const rsi2 = computeRSI(closes.slice(0, offset + priceHigh2Idx + 1), 14);

  const earlierPrice = priceHigh1Idx < priceHigh2Idx ? priceHigh1 : priceHigh2;
  const laterPrice = priceHigh1Idx < priceHigh2Idx ? priceHigh2 : priceHigh1;
  const earlierRsi = priceHigh1Idx < priceHigh2Idx ? rsi1 : rsi2;
  const laterRsi = priceHigh1Idx < priceHigh2Idx ? rsi2 : rsi1;

  return laterPrice > earlierPrice && laterRsi < earlierRsi;
}
