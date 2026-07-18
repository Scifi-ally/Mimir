/**
 * Market Regime Engine — Layer 1
 * ─────────────────────────────────────────────────────────────────────────────
 * Classifies the current market regime using 7 granular states.
 * Runs BEFORE scanning begins — the scanner must understand the current
 * market environment.
 *
 * Inputs:
 *   • NIFTY Trend (daily change + momentum)
 *   • BANK NIFTY Trend
 *   • India VIX
 *   • Market Breadth (advance/decline)
 *   • FII/DII Flow
 *   • Sector Strength (% of sectors in uptrend)
 *   • Market Momentum (rate of change over 5/10/20 days)
 *
 * Output:
 *   {
 *     regime: "BULLISH_EXPANSION" | "BULLISH_STEADY" | ...
 *     confidence: 0-100,
 *     volatility: "Low" | "Moderate" | "High" | "Extreme",
 *     strength: 0-100,
 *     scannerActivation: { ... }
 *   }
 */
import { updateMarketState, getMarketState } from "../market_data/market_state";
import { getConfig } from "../config";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { getGlobalMacroState } from "./global_macro";
import { logger } from "../lib/logger";

const STARTUP_TIME = Date.now();

// ── Regime types ─────────────────────────────────────────────────────────────

export type MarketRegime =
  | "BULLISH_EXPANSION"     // Strong uptrend with breadth + momentum
  | "BULLISH_STEADY"        // Uptrend but weakening breadth
  | "BEARISH_CONTRACTION"   // Strong downtrend with selling pressure
  | "BEARISH_STEADY"        // Downtrend but weakening selling
  | "SIDEWAYS_RANGE"        // No trend, range-bound
  | "HIGH_VOLATILITY"       // VIX spike, unstable
  | "LOW_VOLATILITY_SQUEEZE" // Compression, pending breakout
  | "UNKNOWN";

export type VolatilityClassification = "Low" | "Moderate" | "High" | "Extreme";

export interface RegimeOutput {
  regime: MarketRegime;
  confidence: number;       // 0-100
  volatility: VolatilityClassification;
  strength: number;         // 0-100 overall market strength
  niftyMomentum: number;    // Rate of change
  sectorBreadth: number;    // % of sectors in uptrend
  suggestionsPaused: boolean;
  pauseReason: string | null;
  timestamp: string;
  decisionReason?: string;
  inputsForced?: boolean;
}

// ── Legacy regime mapping (backward compat with existing code) ───────────────

function toLegacyRegime(regime: MarketRegime): "TRENDING_UP" | "TRENDING_DOWN" | "VOLATILE" | "RANGING" | "UNKNOWN" {
  switch (regime) {
    case "BULLISH_EXPANSION":
    case "BULLISH_STEADY":
      return "TRENDING_UP";
    case "BEARISH_CONTRACTION":
    case "BEARISH_STEADY":
      return "TRENDING_DOWN";
    case "HIGH_VOLATILITY":
      return "VOLATILE";
    case "SIDEWAYS_RANGE":
    case "LOW_VOLATILITY_SQUEEZE":
      return "RANGING";
    default:
      return "UNKNOWN";
  }
}

// ── Volatility classification ────────────────────────────────────────────────

function classifyVolatility(vix: number | null): VolatilityClassification {
  if (vix === null) return "Moderate";
  if (vix < 12) return "Low";
  if (vix < 18) return "Moderate";
  if (vix < 25) return "High";
  return "Extreme";
}

// ── Momentum score ───────────────────────────────────────────────────────────

function computeMomentumScore(niftyChangePct: number | null, fiiNetInr: number | null, diiNetInr: number | null): number {
  let momentum = 50; // neutral baseline

  if (niftyChangePct !== null) {
    // Nifty daily change contributes ±30 points
    momentum += Math.max(-30, Math.min(30, niftyChangePct * 20));
  }

  if (fiiNetInr !== null) {
    // FII flow contributes ±15 points (normalized by 5000 Cr = max)
    momentum += Math.max(-15, Math.min(15, (fiiNetInr / 5000) * 15));
  }

  if (diiNetInr !== null) {
    // DII flow contributes ±5 points
    momentum += Math.max(-5, Math.min(5, (diiNetInr / 3000) * 5));
  }

  return Math.max(0, Math.min(100, momentum));
}

// ── Sector breadth ───────────────────────────────────────────────────────────

function computeSectorBreadth(topSectors: Array<{ name: string; changePct: number }>): number {
  if (topSectors.length === 0) return 50;
  const positiveSectors = topSectors.filter(s => s.changePct > 0).length;
  return Math.round((positiveSectors / topSectors.length) * 100);
}

// ── Market strength ──────────────────────────────────────────────────────────

function computeMarketStrength(
  _niftyChangePct: number | null,
  advanceCount: number,
  declineCount: number,
  sectorBreadth: number,
  momentum: number,
  vix: number | null,
): number {
  let strength = 50;

  // A/D ratio contribution (±20)
  const total = advanceCount + declineCount;
  if (total > 0) {
    const adRatio = advanceCount / total;
    strength += (adRatio - 0.5) * 40; // 0.75 → +10, 0.25 → -10
  }

  // Sector breadth contribution (±15)
  strength += (sectorBreadth - 50) * 0.3;

  // Momentum contribution (±10)
  strength += (momentum - 50) * 0.2;

  // VIX penalty (high VIX reduces strength)
  if (vix !== null && vix > 20) {
    strength -= Math.min(15, (vix - 20) * 0.75);
  }

  return Math.max(0, Math.min(100, Math.round(strength)));
}

// ── Core regime detection ────────────────────────────────────────────────────

let _lastRegimeOutput: RegimeOutput | null = null;

// Latched true while a VIX-caused pause is in effect; cleared only when VIX
// falls back below the warn zone (see hysteresis band in Steps 1–2).
let _vixPauseLatched = false;

export function getLastRegimeOutput(): RegimeOutput | null {
  return _lastRegimeOutput;
}

export function detectRegime(): void {
  const state = getMarketState();
  let niftyChangePct = state.niftyChangePct;
  let indiaVix = state.indiaVix;
  let advanceCount = state.advanceCount;
  let declineCount = state.declineCount;
  let fiiNetInr = state.fiiNetInr;
  let diiNetInr = state.diiNetInr;
  const topSectors = state.topSectors;

  const { vixPauseThreshold } = getConfig();
  const elapsedMs = Date.now() - STARTUP_TIME;
  const isInitialGrace = elapsedMs < 5000;
  let inputsForced = false;

  // Only a real feed reading may drive VIX pause/latch transitions — the
  // fabricated 14.2 default below exists solely for regime classification.
  const vixIsReal = indiaVix !== null && indiaVix > 0;

  // Feed values as actually observed — broadcasts must never carry the
  // forced classification defaults below as if they were live readings.
  const observedIndiaVix = vixIsReal ? indiaVix : null;
  const observedNiftyChangePct = niftyChangePct;

  if (niftyChangePct === null || indiaVix === null) {
    if (isInitialGrace) {
      _lastRegimeOutput = {
        regime: "UNKNOWN",
        confidence: 0,
        volatility: "Moderate",
        strength: 50,
        niftyMomentum: 50,
        sectorBreadth: 50,
        suggestionsPaused: false,
        pauseReason: "Initializing regime engine...",
        timestamp: new Date().toISOString(),
        decisionReason: "Calculating...",
        inputsForced: false,
      };
      updateMarketState({ regime: "UNKNOWN", suggestionsPaused: false, pauseReason: "Initializing..." });
      return;
    } else {
      // Force deterministic classification with NEUTRAL values — fabricated
      // bullish defaults (+0.45% / 1250 adv / +450Cr FII) previously biased
      // the regime engine toward BULLISH whenever real data was missing.
      inputsForced = true;
      indiaVix = (indiaVix ?? 0) > 0 ? indiaVix! : 14.2;
      niftyChangePct = niftyChangePct !== null ? niftyChangePct : 0;
      advanceCount = advanceCount > 0 ? advanceCount : 1000;
      declineCount = declineCount > 0 ? declineCount : 1000;
      fiiNetInr = fiiNetInr ?? 0;
      diiNetInr = diiNetInr ?? 0;
    }
  }

  const previousRegime = state.regime;
  const previousPaused = state.suggestionsPaused;

  let regime: MarketRegime = "UNKNOWN";
  let confidence = 0;
  let suggestionsPaused = false;
  let pauseReason: string | null = null;

  const volatility = classifyVolatility(indiaVix);
  const momentum = computeMomentumScore(niftyChangePct, fiiNetInr, diiNetInr);
  const sectorBreadth = computeSectorBreadth(topSectors);
  const adTotal = advanceCount + declineCount;

  const advancePct = adTotal > 0 ? (advanceCount / adTotal) * 100 : 50;

  // Clear the VIX pause latch once a real VIX reading drops out of the
  // hysteresis band — a feed outage (fabricated default) must not unlatch.
  if (vixIsReal && indiaVix !== null && indiaVix <= vixPauseThreshold * 0.95) {
    _vixPauseLatched = false;
  }

  // ── Step 1: VIX gate (hard pause) ───────────────────────────────────────
  if (vixIsReal && indiaVix !== null && indiaVix > vixPauseThreshold) {
    regime = "HIGH_VOLATILITY";
    confidence = Math.min(95, 60 + (indiaVix - vixPauseThreshold) * 3);
    suggestionsPaused = true;
    _vixPauseLatched = true;
    pauseReason = `India VIX ${indiaVix.toFixed(1)} exceeds pause threshold (${vixPauseThreshold}) — all signals paused`;
  }
  // ── Step 2: VIX warn zone ──────────────────────────────────────────────
  // Hysteresis band: pause at vix > threshold, resume only once vix drops
  // below threshold * 0.95 — a VIX hovering at the threshold no longer
  // flips suggestionsPaused on every tick.
  else if (vixIsReal && indiaVix !== null && indiaVix > vixPauseThreshold * 0.95) {
    regime = "HIGH_VOLATILITY";
    confidence = 55;
    if (_vixPauseLatched) {
      // Still inside the band after a VIX-caused pause — hold the pause.
      suggestionsPaused = true;
      pauseReason = `India VIX ${indiaVix.toFixed(1)} still near pause threshold (${vixPauseThreshold}) — signals held paused (hysteresis)`;
    } else {
      suggestionsPaused = false;
      pauseReason = null;
    }
  }
  // ── Step 2b: VIX feed outage while latched — hold the pause ───────────
  // With no real reading, neither pausing nor resuming is justified; keep
  // the latched pause until live VIX returns rather than trusting 14.2.
  else if (!vixIsReal && _vixPauseLatched) {
    regime = "HIGH_VOLATILITY";
    confidence = 55;
    suggestionsPaused = true;
    pauseReason = `India VIX unavailable — VIX pause held until a live reading returns (threshold ${vixPauseThreshold})`;
  }
  // ── Step 3: Low volatility squeeze detection ───────────────────────────
  else if (indiaVix !== null && indiaVix < 12 && niftyChangePct !== null && Math.abs(niftyChangePct) < 0.15) {
    regime = "LOW_VOLATILITY_SQUEEZE";
    confidence = 65;
  }
  // ── Step 4: Trend classification ───────────────────────────────────────
  else if (niftyChangePct !== null) {
    if (niftyChangePct > 0.5) {
      if (advancePct > 60 && sectorBreadth > 60) {
        // Strong breadth + strong nifty = bullish expansion
        regime = "BULLISH_EXPANSION";
        confidence = Math.min(95, 65 + (niftyChangePct * 10) + (advancePct - 60) * 0.5);
      } else {
        regime = "BULLISH_STEADY";
        confidence = Math.min(85, 55 + (niftyChangePct * 8) + (advancePct - 50) * 0.3);
      }
    } else if (niftyChangePct > 0.2) {
      // Moderate nifty up
      regime = "BULLISH_STEADY";
      confidence = Math.min(85, 55 + (niftyChangePct * 8) + (advancePct - 50) * 0.3);
    } else if (niftyChangePct < -0.5) {
      if (advancePct < 40 && sectorBreadth < 40) {
        // Strong selling + weak breadth = bearish contraction
        regime = "BEARISH_CONTRACTION";
        confidence = Math.min(95, 65 + (Math.abs(niftyChangePct) * 10) + (40 - advancePct) * 0.5);
      } else {
        regime = "BEARISH_STEADY";
        confidence = Math.min(85, 55 + (Math.abs(niftyChangePct) * 8) + (50 - advancePct) * 0.3);
      }
    } else if (niftyChangePct < -0.2) {
      // Moderate nifty down
      regime = "BEARISH_STEADY";
      confidence = Math.min(85, 55 + (Math.abs(niftyChangePct) * 8) + (50 - advancePct) * 0.3);
    } else {
      // Flat market
      regime = "SIDEWAYS_RANGE";
      confidence = 60;
    }
  }

  // ── Step 5: FII/DII flow modifier ──────────────────────────────────────
  if (fiiNetInr !== null && regime !== "HIGH_VOLATILITY") {
    if (fiiNetInr > 2000) {
      // Strong FII buying can upgrade regime (at most one step)
      if (regime === "UNKNOWN" || regime === "SIDEWAYS_RANGE") {
        regime = "BULLISH_STEADY";
        confidence = Math.max(confidence, 60);
      } else if (regime === "BULLISH_STEADY") {
        regime = "BULLISH_EXPANSION";
        confidence = Math.min(confidence + 10, 95);
      }
    } else if (fiiNetInr < -2000) {
      // Strong FII selling can downgrade regime (at most one step)
      if (regime === "UNKNOWN" || regime === "SIDEWAYS_RANGE") {
        regime = "BEARISH_STEADY";
        confidence = Math.max(confidence, 60);
      } else if (regime === "BEARISH_STEADY") {
        regime = "BEARISH_CONTRACTION";
        confidence = Math.min(confidence + 10, 95);
      }
      // Heavy FII selling in downtrend → pause
      if (regime === "BEARISH_CONTRACTION" && !suggestionsPaused) {
        suggestionsPaused = true;
        pauseReason = `FII net selling ₹${Math.abs(fiiNetInr).toFixed(0)} Cr — high risk`;
      }
    }
  }

  // Relax a VIX-caused pause if strong FII buying and VIX only marginally
  // above the pause threshold (checked outside the regime-guarded block —
  // paused states are HIGH_VOLATILITY and were excluded above).
  if (
    suggestionsPaused &&
    regime === "HIGH_VOLATILITY" &&
    fiiNetInr !== null && fiiNetInr > 2000 &&
    vixIsReal && indiaVix !== null && indiaVix <= vixPauseThreshold * 1.05
  ) {
    suggestionsPaused = false;
    pauseReason = null;
    _vixPauseLatched = false;
    logger.info({ fiiNetInr, indiaVix }, "Signals un-paused — elevated VIX offset by strong FII buying");
  }

  // Compute market strength
  const strength = computeMarketStrength(niftyChangePct, advanceCount, declineCount, sectorBreadth, momentum, indiaVix);

  // ── Step 6: Geopolitical risk override ───────────────────────────────────
  const macroState = getGlobalMacroState();
  if (macroState.geopoliticalRisk === "EXTREME" && !suggestionsPaused) {
    suggestionsPaused = true;
    pauseReason = "Extreme geopolitical risk — multiple macro stress signals active";
  } else if (macroState.geopoliticalRisk === "HIGH" && regime !== "BULLISH_EXPANSION") {
    confidence = Math.max(confidence - 10, 30);
  }

  const niftyTrendText = niftyChangePct >= 0 ? "NIFTY up on day" : "NIFTY down on day";
  const breadthText = advanceCount >= declineCount ? "Breadth Positive" : "Breadth Negative";
  const decisionReason = `${niftyTrendText}, ${breadthText}, Sector Participation ${sectorBreadth}%, Geo Risk: ${macroState.geopoliticalRisk}`;

  // Build output
  const output: RegimeOutput = {
    regime,
    confidence: Math.round(confidence),
    volatility,
    strength,
    niftyMomentum: Math.round(momentum),
    sectorBreadth,
    suggestionsPaused,
    pauseReason,
    timestamp: new Date().toISOString(),
    decisionReason,
    inputsForced,
  };

  _lastRegimeOutput = output;

  // Update market state (using legacy regime for backward compat)
  const legacyRegime = toLegacyRegime(regime);
  updateMarketState({ 
    regime: legacyRegime, 
    suggestionsPaused, 
    pauseReason,
    decisionReason,
    inputsForced,
  });

  // Broadcast regime change if state changed
  if (legacyRegime !== previousRegime || suggestionsPaused !== previousPaused) {
    broadcast(createServerEvent.marketRegimeChanged({
      regime: legacyRegime,
      detailedRegime: regime,
      confidence: output.confidence,
      volatility: output.volatility,
      strength: output.strength,
      indiaVix: observedIndiaVix,
      niftyChange: observedNiftyChangePct,
      sectorBreadth: output.sectorBreadth,
      momentum: output.niftyMomentum,
      suggestionsPaused,
      pauseReason,
    }));
  }

  logger.info(
    {
      regime,
      legacyRegime,
      confidence: output.confidence,
      volatility,
      strength,
      momentum,
      sectorBreadth,
      suggestionsPaused,
      fiiNetInr,
      diiNetInr,
    },
    "Market regime updated (v2)",
  );
}
