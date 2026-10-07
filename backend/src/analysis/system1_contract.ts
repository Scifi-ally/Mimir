/**
 * Unified System-1 Fast Decision Contract.
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical, single source of truth for System-1 fast-decision primitives across
  *
 * Core Primitives:
 * 1. Choice: Discrete categorical classifications (Verdict, Action).
 * 2. Score: Bounded decision scores; trading probability calibration is not established.
 * 3. Execution probabilities: unknown until validated on actual labelled executions.
 * 4. Position sizing: unvalidated conviction may reduce risk, never increase it.
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
  /** Decision score; calibration as a trading probability is not established. */
  confidence: number;
  /** Score Primitive: aggregate opportunity score in [0.0, 100.0] */
  opportunity_score: number;
  /** Score Primitive: directional regime alignment in [-1.0, 1.0] */
  regime_alignment: number;
  /** Unknown until an execution-labelled calibration artifact is validated. */
  p_execution_success: number | null;
  p_stop_hunt_risk: number | null;
  p_adverse_regime_shift: number | null;
  probability_validation?: "not_established";
  confidence_kind?: "decision_score_not_win_probability";
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
