import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeNativeLayaDecision,
  evaluateLayaDecision,
  type System1DecisionRequest,
} from "./ai_client";

/**
 * These cases assert the *offline* native-TS fallback. Without pinning
 * AI_SERVICE_URL to an unroutable address they would silently exercise a live
 * microservice on :8001 whenever a developer happens to have one running, so
 * the suite would pass or fail based on machine state.
 */
describe("LAYA System-1 offline fallback", () => {
  const originalUrl = process.env.AI_SERVICE_URL;
  beforeEach(() => {
    // Reserved TEST-NET-1 address: connection refused, no DNS lookup, no wait.
    process.env.AI_SERVICE_URL = "http://127.0.0.1:1";
  });
  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.AI_SERVICE_URL;
    } else {
      process.env.AI_SERVICE_URL = originalUrl;
    }
  });

  it("should evaluate evaluateLayaDecision via native fallback if microservice is offline", async () => {
    const req: System1DecisionRequest = {
      symbol: "AXISBANK",
      direction: "BUY",
      risk_reward_ratio: 2.3,
      technical_score: 85.0,
      india_vix: 13.0,
      market_regime: "BULL_TRENDING",
    };
    const decision = await evaluateLayaDecision(req);
    expect(decision).toBeDefined();
    expect(decision.verdict).toBe("APPROVE");
    expect(decision.provider).toBe("laya");
    expect(decision.source).toBe("native_ts_laya");
  });



});

describe("LAYA System-1 Native Decision Gatekeeper", () => {
  it("should APPROVE a high-conviction bullish setup aligned with bull regime", () => {
    const req: System1DecisionRequest = {
      symbol: "TCS",
      direction: "BUY",
      setup_type: "PULLBACK",
      technical_score: 82.0,
      risk_reward_ratio: 2.5,
      order_flow_imbalance_ratio: 0.4,
      fii_dii_net: 1200,
      india_vix: 13.5,
      market_regime: "BULL_TRENDING",
      chronos_trend: "bullish",
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("APPROVE");
    expect(decision.action).toBe("EXECUTE_IMMEDIATELY");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.65);
    expect(decision.gate_reasons).toContain("STRONG_SYSTEM_ONE_CONVICTION");
    expect(decision.position_size_multiplier).toBe(1.0);
    expect(decision.provider).toBe("laya");
    // This is a hand-written deterministic heuristic, NOT the ConvAI Innovations
    // LAYA model. It must never claim the real model id, or every downstream
    // metric keyed on model_id attributes heuristic output to a calibrated
    // neural model.
    expect(decision.model_id).toBe("native_ts_deterministic_surrogate");
    expect(decision.model_id).not.toBe("convaiinnovations/laya");
    expect(decision.source).toBe("native_ts_laya");
    // Noul primitives
    expect(decision.p_execution_success).toBeNull();
    expect(decision.p_stop_hunt_risk).toBeNull();
    expect(decision.p_adverse_regime_shift).toBeNull();
  });

  it("should safely handle null, undefined, or NaN fields without crashing or NaNs", () => {
    const req: System1DecisionRequest = {
      symbol: "NULLTEST",
      direction: undefined,
      risk_reward_ratio: NaN,
      technical_score: NaN,
      india_vix: undefined,
      win_probability: null,
      order_flow_imbalance_ratio: undefined,
      fii_dii_net: undefined,
    };
    const decision = computeNativeLayaDecision(req);
    expect(["APPROVE", "CAUTION", "REJECT"]).toContain(decision.verdict);
    expect(Number.isFinite(decision.opportunity_score)).toBe(true);
    expect(Number.isFinite(decision.confidence)).toBe(true);
    expect(decision.p_execution_success).toBeNull();
    expect(decision.p_stop_hunt_risk).toBeNull();
    expect(decision.p_adverse_regime_shift).toBeNull();
  });

  it("should REJECT setup when India VIX spikes above 25 with elevated stop hunt risk", () => {
    const req: System1DecisionRequest = {
      symbol: "INFY",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      india_vix: 27.5,
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("REJECT");
    expect(decision.action).toBe("CANCEL");
    expect(decision.gate_reasons).toContain("HIGH_VOLATILITY_VIX_SPIKE");
    expect(decision.p_stop_hunt_risk).toBeNull();
    expect(decision.p_execution_success).toBeNull();
  });

  it("should REJECT setup when Risk-Reward ratio is below 1.2", () => {
    const req: System1DecisionRequest = {
      symbol: "HDFCBANK",
      direction: "BUY",
      risk_reward_ratio: 1.05,
      india_vix: 14.0,
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("REJECT");
    expect(decision.action).toBe("CANCEL");
    expect(decision.gate_reasons.some((r) => r.includes("UNFAVORABLE_RISK_REWARD"))).toBe(true);
  });

  it("should REJECT setup when institutional FII net selling is severe", () => {
    const req: System1DecisionRequest = {
      symbol: "ICICIBANK",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      fii_dii_net: -3500,
      india_vix: 14.0,
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("REJECT");
    expect(decision.action).toBe("CANCEL");
    expect(decision.gate_reasons).toContain("HEAVY_INSTITUTIONAL_SELLING");
  });

  it("should REJECT setup when order flow imbalance severely contradicts trade direction", () => {
    const req: System1DecisionRequest = {
      symbol: "RELIANCE",
      direction: "BUY",
      risk_reward_ratio: 2.2,
      india_vix: 14.0,
      order_flow_imbalance_ratio: -0.45,
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("REJECT");
    expect(decision.action).toBe("CANCEL");
    expect(decision.position_size_multiplier).toBe(0.0);
    expect(decision.gate_reasons).toContain("SEVERE_ORDER_FLOW_CONTRADICTION");
  });

  it("should output CAUTION and LIMIT_PULLBACK when opportunity is moderate", () => {
    const req: System1DecisionRequest = {
      symbol: "SBIN",
      direction: "BUY",
      risk_reward_ratio: 1.8,
      technical_score: 55.0,
      india_vix: 15.0,
      market_regime: "SIDEWAYS",
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("CAUTION");
    expect(decision.action).toBe("LIMIT_PULLBACK");
    expect(decision.gate_reasons).toContain("MODERATE_OPPORTUNITY_REQUIRE_CONFIRMATION");
  });
});

