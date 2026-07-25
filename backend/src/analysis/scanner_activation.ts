/**
 * Scanner Activation Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Dynamically enables/disables scanner types based on the current market regime.
 * This ensures the system only looks for setups that make sense in the current
 * market environment, reducing false positives.
 */
import type { MarketRegime } from "./regime_detector";
import { getLastRegimeOutput } from "./regime_detector";
import { logger } from "../lib/logger";

export type ScannerType =
  | "BREAKOUT"
  | "MOMENTUM_CONTINUATION"
  | "PULLBACK"
  | "EMA9_RECLAIM"
  | "MACD_CROSSOVER"
  | "BOLLINGER_SQUEEZE_BREAKOUT"
  | "BREAKDOWN"
  | "BEAR_MOMENTUM"
  | "EMA9_REJECTION"
  | "MEAN_REVERSION"
  | "RANGE_TRADING"
  | "LIQUIDITY_SWEEP";

export interface ScannerActivation {
  regime: MarketRegime;
  enabled: ScannerType[];
  disabled: ScannerType[];
  notes: string[];
}

// ── Activation matrix ────────────────────────────────────────────────────────

const ACTIVATION_MATRIX: Record<MarketRegime, { enabled: ScannerType[]; notes: string[] }> = {
  BULLISH_EXPANSION: {
    enabled: [
      "BREAKOUT",
      "MOMENTUM_CONTINUATION",
      "PULLBACK",
      "EMA9_RECLAIM",
      "MACD_CROSSOVER",
      "BOLLINGER_SQUEEZE_BREAKOUT",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Full bullish scanner suite active",
      "Breakout + momentum + trend continuation enabled",
      "Short scanners disabled — regime strongly bullish",
    ],
  },
  BULLISH_STEADY: {
    enabled: [
      "BREAKOUT",
      "PULLBACK",
      "EMA9_RECLAIM",
      "MACD_CROSSOVER",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Conservative bullish scanners active",
      "Momentum disabled — breadth weakening",
      "Focus on pullback entries and confirmed breakouts",
    ],
  },
  BEARISH_CONTRACTION: {
    enabled: [
      "BREAKDOWN",
      "BEAR_MOMENTUM",
      "EMA9_REJECTION",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Full bearish scanner suite active",
      "All bullish scanners disabled",
      "Breakdown + bear momentum + rejection at resistance",
    ],
  },
  BEARISH_STEADY: {
    enabled: [
      "BREAKDOWN",
      "EMA9_REJECTION",
      "MEAN_REVERSION",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Defensive bearish scanners active",
      "Mean reversion enabled — selling pressure weakening",
      "Bear momentum disabled — trend losing strength",
    ],
  },
  SIDEWAYS_RANGE: {
    enabled: [
      "MEAN_REVERSION",
      "RANGE_TRADING",
      "BOLLINGER_SQUEEZE_BREAKOUT",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Range-bound scanners active",
      "Trend-following scanners disabled",
      "Focus on support/resistance extremes + squeeze breakouts",
    ],
  },
  HIGH_VOLATILITY: {
    enabled: [
      "MEAN_REVERSION",
      "RANGE_TRADING",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Mean reversion and range trading active in high volatility",
      "Trend following disabled",
      "Capital preservation with defensive setups",
    ],
  },
  LOW_VOLATILITY_SQUEEZE: {
    enabled: [
      "BREAKOUT",
      "BREAKDOWN",
      "BOLLINGER_SQUEEZE_BREAKOUT",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Squeeze breakout scanners active",
      "Low volatility = compression = pending explosion",
      "Watch for directional breakout with volume",
    ],
  },
  UNKNOWN: {
    enabled: [
      "BREAKOUT",
      "PULLBACK",
      "MACD_CROSSOVER",
      "LIQUIDITY_SWEEP",
    ],
    notes: [
      "Unknown regime — conservative scanner set",
      "Only high-probability setups enabled",
    ],
  },
};

const ALL_SCANNERS: ScannerType[] = [
  "BREAKOUT",
  "MOMENTUM_CONTINUATION",
  "PULLBACK",
  "EMA9_RECLAIM",
  "MACD_CROSSOVER",
  "BOLLINGER_SQUEEZE_BREAKOUT",
  "BREAKDOWN",
  "BEAR_MOMENTUM",
  "EMA9_REJECTION",
  "MEAN_REVERSION",
  "RANGE_TRADING",
  "LIQUIDITY_SWEEP",
];

// ── Public API ───────────────────────────────────────────────────────────────

export function getScannerActivation(): ScannerActivation {
  const regimeOutput = getLastRegimeOutput();
  const regime: MarketRegime = regimeOutput?.regime ?? "UNKNOWN";

  const config = ACTIVATION_MATRIX[regime];
  const enabled = config.enabled;
  const disabled = ALL_SCANNERS.filter(s => !enabled.includes(s));

  logger.debug(
    { regime, enabledCount: enabled.length, disabledCount: disabled.length },
    "Scanner activation computed",
  );

  return {
    regime,
    enabled,
    disabled,
    notes: config.notes,
  };
}

export function isScannerEnabled(scannerType: string): boolean {
  const activation = getScannerActivation();
  return activation.enabled.includes(scannerType as ScannerType);
}

/**
 * Returns a setup type to ScannerType mapping for filtering
 */
export function setupTypeToScannerType(setupType: string): ScannerType | null {
  const map: Record<string, ScannerType> = {
    "BREAKOUT": "BREAKOUT",
    "MOMENTUM_CONTINUATION": "MOMENTUM_CONTINUATION",
    "PULLBACK": "PULLBACK",
    "EMA9_RECLAIM": "EMA9_RECLAIM",
    "MACD_CROSSOVER": "MACD_CROSSOVER",
    "BOLLINGER_SQUEEZE_BREAKOUT": "BOLLINGER_SQUEEZE_BREAKOUT",
    "BREAKDOWN": "BREAKDOWN",
    "BEAR_MOMENTUM": "BEAR_MOMENTUM",
    "EMA9_REJECTION": "EMA9_REJECTION",
    "MEAN_REVERSION_LONG": "MEAN_REVERSION",
    "MEAN_REVERSION_SHORT": "MEAN_REVERSION",
    "RANGE_LONG": "RANGE_TRADING",
    "RANGE_SHORT": "RANGE_TRADING",
    "LIQUIDITY_SWEEP": "LIQUIDITY_SWEEP",
  };
  return map[setupType] ?? null;
}
