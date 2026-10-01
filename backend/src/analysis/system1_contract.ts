/**
 * Unified System-1 Fast Decision Contract.
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical, single source of truth for System-1 fast-decision primitives across
  *
 * Core Primitives:
 * 1. Choice: Discrete categorical classifications (Verdict, Action).
 * 2. Score: Continuous calibrated metrics in bounded domains (Confidence, Opportunity, Regime Alignment).
 * 3. Noul: Calibrated Bernoulli probabilities (P in [0, 1]) optimized via strictly proper scoring rules.
 * 4. Position Sizing Scaling: Dynamic multiplier in [0.5x, 1.25x] based on calibrated confidence and agreement.
 */

export type System1Verdict = "APPROVE" | "REJECT" | "CAUTION";

export type System1Action =
  | "EXECUTE_IMMEDIATELY"
  | "CONFIRMED_ENTRY"
  | "LIMIT_PULLBACK"
  | "CANCEL";

export type System1Provider = "laya" | "native_ts_laya";

/**
 * Strongly typed System-1 decision record.
 */
export interface System1Decision {
  /** Choice Primitive: high-level trade verdict */
  verdict: System1Verdict;
  /** Choice Primitive: recommended execution behavior */
  action: System1Action;
  /** Score Primitive: RLCD-calibrated confidence in [0.0, 1.0] */
  confidence: number;
  /** Score Primitive: aggregate opportunity score in [0.0, 100.0] */
  opportunity_score: number;
  /** Score Primitive: directional regime alignment in [-1.0, 1.0] */
  regime_alignment: number;
  /** Noul Primitive: calibrated Bernoulli probability of execution success */
  p_execution_success: number;
  /** Noul Primitive: calibrated Bernoulli probability of wick stop-hunt */
  p_stop_hunt_risk: number;
  /** Noul Primitive: calibrated Bernoulli probability of adverse regime shift */
  p_adverse_regime_shift: number;
  /** Dynamic position sizing multiplier (0.5x - 1.25x for valid trades, 0.0x for rejections) */
  position_size_multiplier?: number;
  /** Explanatory gate reasons / audit trail */
  gate_reasons: string[];
  /** Model provider: the Laya weights, or the native fallback scorer. */
  provider: System1Provider;
  /** Identifier of the model (e.g. "convaiinnovations/laya"). */
  model_id: string;
  /** Source descriptor for telemetry */
  source: string;
  /** Total inference latency in milliseconds */
  latency_ms?: number;
}

/**
 * Standardized input state for System-1 decision evaluation.
 */
export interface System1DecisionRequest {
  symbol: string;
  direction?: "BUY" | "SELL" | string;
  setup_type?: string;
  timeframe?: string;
  entry_price?: number;
  stop_loss?: number;
  target1?: number;
  risk_reward_ratio?: number;
  technical_score?: number;
  chronos_trend?: string;
  sentiment_score?: number;
  order_flow_imbalance_ratio?: number;
  fii_dii_net?: number;
  india_vix?: number;
  market_regime?: string;
  win_probability?: number | null;
  preferred_engine?: "laya";
}
