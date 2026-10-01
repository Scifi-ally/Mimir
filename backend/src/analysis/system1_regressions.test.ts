/**
 * Regression tests for previously-fixed defects in the System-1 / sizing path.
 *
 * Each test reproduces a concrete shipped bug, and is written so that reverting
 * the corresponding fix makes it FAIL.
 */

import { describe, it, expect } from "vitest";
import {
  computeNativeLayaDecision,
  computeNativeSystem1Decision,
  type System1DecisionRequest,
} from "./ai_client";

const CLEAN_SETUP: System1DecisionRequest = {
  symbol: "REGR",
  direction: "BUY",
  setup_type: "BREAKOUT",
  technical_score: 88,
  risk_reward_ratio: 2.5,
  order_flow_imbalance_ratio: 0.4,
  fii_dii_net: 1200,
  india_vix: 13.0,
  market_regime: "BULL_TRENDING",
  chronos_trend: "bullish",
};

describe("System-1 honest attribution", () => {
  it("must not impersonate the real Laya model from the native fallback scorer", () => {
    for (const dec of [
      computeNativeLayaDecision(CLEAN_SETUP),
      computeNativeLayaDecision(CLEAN_SETUP),
      computeNativeSystem1Decision(CLEAN_SETUP),
    ]) {
      // This is a hand-written deterministic heuristic. Attributing it to a
      // calibrated neural model corrupts every metric keyed on model_id.
      expect(dec.model_id).toBe("native_ts_deterministic_surrogate");
      expect(dec.model_id).not.toBe("convaiinnovations/laya");
    }
  });

  it("must mark the source as a native surrogate so downstream can flag it", () => {
    expect(computeNativeLayaDecision(CLEAN_SETUP).source).toBe("native_ts_laya");
    expect(computeNativeSystem1Decision(CLEAN_SETUP).source).toBe("native_ts_laya");
  });
});

describe("System-1 position sizing is risk-aware", () => {
  it("scales UP only when execution odds are clean", () => {
    const dec = computeNativeLayaDecision(CLEAN_SETUP);
    expect(dec.p_execution_success).toBeGreaterThanOrEqual(0.7);
    expect(dec.p_stop_hunt_risk).toBeLessThanOrEqual(0.2);
    expect(dec.position_size_multiplier).toBe(1.25);
  });

  it("scales DOWN when stop-hunt risk is elevated, even at high confidence", () => {
    // Same conviction, but a regime that makes wick stop-outs likely.
    const risky = computeNativeLayaDecision({
      ...CLEAN_SETUP,
      symbol: "RISKY",
      setup_type: "BREAKOUT",
      india_vix: 19.5,
      market_regime: "VOLATILE",
      risk_reward_ratio: 1.8,
    });
    expect(risky.p_stop_hunt_risk).toBeGreaterThan(0.35);
    // Sizing must reflect the risk rather than ignoring it.
    expect(risky.position_size_multiplier).toBeLessThan(1.25);
  });

  it("never returns a negative or non-finite multiplier", () => {
    const samples: System1DecisionRequest[] = [
      CLEAN_SETUP,
      { ...CLEAN_SETUP, india_vix: 30 },
      { ...CLEAN_SETUP, risk_reward_ratio: 0.2 },
      { ...CLEAN_SETUP, order_flow_imbalance_ratio: -0.9 },
      { ...CLEAN_SETUP, market_regime: "BEAR_TRENDING" },
    ];
    for (const req of samples) {
      const m = computeNativeLayaDecision(req).position_size_multiplier ?? -1;
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1.25);
    }
  });
});

describe("System-1 hard gates cannot be bypassed", () => {
  it("rejects a VIX spike regardless of technical score", () => {
    const dec = computeNativeLayaDecision({ ...CLEAN_SETUP, india_vix: 27 });
    expect(dec.verdict).toBe("REJECT");
    expect(dec.action).toBe("CANCEL");
    expect(dec.position_size_multiplier).toBe(0.0);
  });

  it("rejects a counter-regime short with adverse OFI", () => {
    const dec = computeNativeLayaDecision({
      ...CLEAN_SETUP,
      direction: "SELL",
      order_flow_imbalance_ratio: 0.45,
    });
    expect(dec.verdict).toBe("REJECT");
  });

  it("never returns a REJECT with a non-zero size multiplier", () => {
    const dec = computeNativeLayaDecision({ ...CLEAN_SETUP, india_vix: 28 });
    expect(dec.verdict).toBe("REJECT");
    expect(dec.position_size_multiplier).toBe(0.0);
  });
});

describe("System-1 Noul primitives are state-sensitive", () => {
  it("reports higher fill probability when order flow confirms the direction", () => {
    const aligned = computeNativeLayaDecision({ ...CLEAN_SETUP, order_flow_imbalance_ratio: 0.35 });
    const adverse = computeNativeLayaDecision({ ...CLEAN_SETUP, order_flow_imbalance_ratio: -0.35 });
    expect(aligned.p_execution_success).toBeGreaterThan(adverse.p_execution_success);
  });

  it("keeps all probabilities within [0, 1]", () => {
    const dec = computeNativeLayaDecision({ ...CLEAN_SETUP, india_vix: 26, risk_reward_ratio: 0.5 });
    for (const p of [dec.p_execution_success, dec.p_stop_hunt_risk, dec.p_adverse_regime_shift]) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});
