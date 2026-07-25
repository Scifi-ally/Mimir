/**
 * Market Internals Gate
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts internals the system already tracks into concrete suggestion gates:
 *
 * 1. VIX rate-of-change — a fast VIX spike (>+8% within an hour) is the moment
 *    momentum trades die; absolute VIX level alone misses it. In-memory sample
 *    ring, no new data source.
 * 2. Breadth confirmation — momentum longs in narrow-breadth rallies fail.
 *    Requires advancers to at least match decliners for MOMENTUM_CONTINUATION.
 * 3. Sector relative strength — momentum only in top-half sectors by money
 *    flow (uses topSectors already computed by sector_rotation.ts).
 *
 * All gates fail-open when their input is missing: absence of data must never
 * silently halt generation (the regime detector handles hard pauses).
 */

import { getMarketState } from "../market_data/market_state";
import { STOCK_SECTOR_MAP } from "./stock_scanner";
import { logger } from "../lib/logger";

// ── VIX rate-of-change ────────────────────────────────────────────────────────

interface VixSample {
  value: number;
  at: number;
}

const vixSamples: VixSample[] = [];
const VIX_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const VIX_SPIKE_PCT = 8;              // +8% within window = event risk

/** Record a VIX observation. Called from the market feed on each VIX update. */
export function recordVixSample(value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const now = Date.now();
  vixSamples.push({ value, at: now });
  // Evict samples older than the window, always keeping the latest one.
  while (vixSamples.length > 1 && vixSamples[0]!.at < now - VIX_WINDOW_MS) {
    vixSamples.shift();
  }
}

/** % change of VIX over the last hour, or null with <2 samples. */
export function getVixRateOfChange(): number | null {
  if (vixSamples.length < 2) return null;
  const oldest = vixSamples[0]!;
  const latest = vixSamples[vixSamples.length - 1]!;
  if (latest.at - oldest.at < 5 * 60 * 1000) return null; // need ≥5min of history
  return ((latest.value - oldest.value) / oldest.value) * 100;
}

export function isVixSpiking(): boolean {
  const roc = getVixRateOfChange();
  return roc !== null && roc >= VIX_SPIKE_PCT;
}

// ── TRIN (Arms Index) & TICK ────────────────────────────────────────────────────

export function getTrin(): number | null {
  const state = getMarketState();
  if (state.advanceCount === 0 || state.declineCount === 0) return null;
  if (state.advancingVolume === 0 || state.decliningVolume === 0) return null;
  
  const adRatio = state.advanceCount / state.declineCount;
  const volRatio = state.advancingVolume / state.decliningVolume;
  return adRatio / volRatio;
}

export function getTickIndex(): number {
  const state = getMarketState();
  return state.upTickCount - state.downTickCount;
}

// ── Composite internals gate & score ─────────────────────────────────────────

export interface InternalsCheck {
  allowed: boolean;
  reason: string | null;
}

/**
 * Calculates a composite score for market internals from -100 (extreme bearish) to +100 (extreme bullish).
 */
export function getInternalsScore(): number {
  const state = getMarketState();
  let score = 0;

  // 1. Breadth contribution (-40 to +40)
  const totalIssues = state.advanceCount + state.declineCount;
  if (totalIssues > 0) {
    const breadthRatio = (state.advanceCount - state.declineCount) / totalIssues;
    score += breadthRatio * 40;
  }

  // 2. TRIN contribution (-30 to +30)
  const trin = getTrin();
  if (trin !== null) {
    if (trin < 0.8) score += 20; // Bullish (buying volume dominance)
    else if (trin < 1.0) score += 10;
    else if (trin > 1.2) score -= 20; // Bearish (selling volume dominance)
    else if (trin > 1.0) score -= 10;
  }

  // 3. TICK contribution (-30 to +30)
  const tick = getTickIndex();
  if (tick > 20) score += 30; // Strong buying pressure
  else if (tick > 0) score += 10;
  else if (tick < -20) score -= 30; // Strong selling pressure
  else if (tick < 0) score -= 10;

  // 4. VIX penalty
  if (isVixSpiking()) {
    score -= 50; // Heavy penalty for spiking volatility
  }

  return Math.max(-100, Math.min(100, score));
}

/**
 * Gate for a prospective suggestion. Strictest for long momentum — the one
 * setup with measured edge, which is also the one that dies in bad internals.
 */
export function checkMarketInternals(
  symbol: string,
  direction: "BUY" | "SELL",
  setupType: string,
): InternalsCheck {
  // 1. VIX spike halts ALL new suggestions — vol regime is changing right now.
  if (isVixSpiking()) {
    return { allowed: false, reason: `VIX spiking (+${getVixRateOfChange()?.toFixed(1)}% in 1h)` };
  }

  if (setupType !== "MOMENTUM_CONTINUATION") return { allowed: true, reason: null };

  const state = getMarketState();

  // 2. Breadth confirmation for momentum longs (fail-open when counts absent).
  if (direction === "BUY" && state.advanceCount > 0 && state.declineCount > 0) {
    if (state.declineCount > state.advanceCount) {
      return {
        allowed: false,
        reason: `Negative breadth (${state.advanceCount} adv / ${state.declineCount} dec) — momentum longs in narrow markets underperform`,
      };
    }
  }

  // 3. Sector relative strength: momentum only in the top half of sectors.
  const sector = STOCK_SECTOR_MAP[symbol];
  if (sector && state.topSectors.length >= 4) {
    const ranked = state.topSectors; // strength-descending (money-flow rank intraday, avg %-change from the scanner)
    const idx = ranked.findIndex((s) => s.name === sector);
    if (idx >= 0 && idx >= Math.ceil(ranked.length / 2)) {
      return {
        allowed: false,
        reason: `Sector ${sector} ranked ${idx + 1}/${ranked.length} by relative strength — momentum needs sector tailwind`,
      };
    }
  }

  // 4. Raw Internals Score Gate
  const internalsScore = getInternalsScore();
  if (direction === "BUY" && internalsScore < -40) {
    return {
      allowed: false,
      reason: `Internals score deeply negative (${internalsScore.toFixed(1)}) — refusing to buy into market selling pressure`,
    };
  }
  if (direction === "SELL" && internalsScore > 40) {
    return {
      allowed: false,
      reason: `Internals score deeply positive (${internalsScore.toFixed(1)}) — refusing to short into market buying pressure`,
    };
  }

  return { allowed: true, reason: null };
}

/** Diagnostic snapshot for the system status endpoint. */
export function getInternalsSnapshot() {
  const state = getMarketState();
  return {
    vixRateOfChangePct: getVixRateOfChange(),
    vixSpiking: isVixSpiking(),
    advanceCount: state.advanceCount,
    declineCount: state.declineCount,
    trin: getTrin(),
    tickIndex: getTickIndex(),
    internalsScore: getInternalsScore(),
    topSectors: state.topSectors.slice(0, 5),
    sampleCount: vixSamples.length,
  };
}

export function logInternals(): void {
  logger.debug(getInternalsSnapshot(), "Market internals snapshot");
}
