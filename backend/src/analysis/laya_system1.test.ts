import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeNativeLayaDecision,
  computeNativeJevDecision,
  computeNativeSystem1Decision,
  evaluateLayaDecision,
  evaluateSystem1Decision,
  type System1DecisionRequest,
} from "./ai_client";
import type { LayaDecision } from "./laya_contract";

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

  it("should support consensus provider evaluation with confidence boost in native surrogate", async () => {
    const req: System1DecisionRequest = {
      symbol: "CONSENSUS_FALLBACK",
      direction: "BUY",
      risk_reward_ratio: 2.3,
      technical_score: 85.0,
      india_vix: 13.0,
      market_regime: "BULL_TRENDING",
    };
    const decision = await evaluateSystem1Decision(req, "consensus");
    expect(decision.provider).toBe("consensus");
    expect(decision.source).toBe("native_ts_laya");
  });

  it("should route evaluateSystem1Decision per engine when offline", async () => {
    const req: System1DecisionRequest = {
      symbol: "KOTAKBANK",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      technical_score: 75.0,
      india_vix: 14.0,
    };
    const decLaya = await evaluateSystem1Decision(req, "laya");
    expect(decLaya.provider).toBe("laya");

    const decJev = await evaluateSystem1Decision(req, "jev");
    expect(decJev.provider).toBe("jev");
  });

  it("should respect SYSTEM1_ENGINE environment variable in evaluateSystem1Decision fallback", async () => {
    const origEngine = process.env.SYSTEM1_ENGINE;
    try {
      process.env.SYSTEM1_ENGINE = "jev";
      const req: System1DecisionRequest = {
        symbol: "ENVTEST",
        direction: "BUY",
        risk_reward_ratio: 2.0,
      };
      const dec = await evaluateSystem1Decision(req);
      expect(dec.provider).toBe("jev");
    } finally {
      if (origEngine !== undefined) {
        process.env.SYSTEM1_ENGINE = origEngine;
      } else {
        delete process.env.SYSTEM1_ENGINE;
      }
    }
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
    expect(decision.position_size_multiplier).toBe(1.25);
    expect(decision.provider).toBe("laya");
    // This is a hand-written deterministic heuristic, NOT the ConvAI Innovations
    // LAYA model. It must never claim the real model id, or every downstream
    // metric keyed on model_id attributes heuristic output to a calibrated
    // neural model.
    expect(decision.model_id).toBe("native_ts_deterministic_surrogate");
    expect(decision.model_id).not.toBe("convaiinnovations/laya");
    expect(decision.source).toBe("native_ts_laya");
    // Noul primitives
    expect(decision.p_execution_success).toBeGreaterThan(0.5);
    expect(decision.p_stop_hunt_risk).toBeLessThan(0.5);
    expect(decision.p_adverse_regime_shift).toBeLessThan(0.5);
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
    expect(Number.isFinite(decision.p_execution_success)).toBe(true);
    expect(Number.isFinite(decision.p_stop_hunt_risk)).toBe(true);
    expect(Number.isFinite(decision.p_adverse_regime_shift)).toBe(true);
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
    expect(decision.p_stop_hunt_risk).toBeGreaterThanOrEqual(0.75);
    expect(decision.p_execution_success).toBeLessThanOrEqual(0.20);
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

describe("Unified System-1 Contract & Router Parity", () => {
  it("should maintain schema parity between Laya and Jev outputs", () => {
    const req: System1DecisionRequest = {
      symbol: "LT",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      technical_score: 80.0,
      india_vix: 14.0,
    };
    const layaDec = computeNativeLayaDecision(req);
    const jevDec = computeNativeJevDecision(req);

    // Common primitives check
    expect(layaDec.verdict).toBe(jevDec.verdict);
    expect(layaDec.action).toBe(jevDec.action);
    expect(layaDec.confidence).toBe(jevDec.confidence);
    expect(layaDec.opportunity_score).toBe(jevDec.opportunity_score);
    expect(layaDec.p_execution_success).toBeDefined();
    expect(jevDec.p_execution_success).toBeDefined();
    expect(layaDec.p_stop_hunt_risk).toBeDefined();
    expect(jevDec.p_stop_hunt_risk).toBeDefined();
    expect(layaDec.p_adverse_regime_shift).toBeDefined();
    expect(jevDec.p_adverse_regime_shift).toBeDefined();

    // Provider check
    expect(layaDec.provider).toBe("laya");
    expect(jevDec.provider).toBe("jev");
    // Both native engines are the same deterministic surrogate and must both
    // identify themselves honestly rather than impersonating a real model.
    expect(layaDec.model_id).toBe("native_ts_deterministic_surrogate");
    expect(jevDec.model_id).toBe("native_ts_deterministic_surrogate");
  });

  it("should scale down position sizing multiplier to 0.65x for CAUTION setups", () => {
    const req: System1DecisionRequest = {
      symbol: "CAUTION_SIZING",
      direction: "BUY",
      setup_type: "BREAKOUT",
      risk_reward_ratio: 1.8,
      technical_score: 55.0,
      india_vix: 15.0,
      market_regime: "SIDEWAYS",
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.verdict).toBe("CAUTION");
    expect(decision.action).toBe("LIMIT_PULLBACK");
    expect(decision.position_size_multiplier).toBe(0.65);
    expect(decision.gate_reasons).toContain("MODERATE_OPPORTUNITY_REQUIRE_CONFIRMATION");
  });

  it("should route high-conviction breakout with elevated stop-hunt risk to LIMIT_PULLBACK", () => {
    const req: System1DecisionRequest = {
      symbol: "BREAKOUT_PULLBACK",
      direction: "BUY",
      setup_type: "BREAKOUT",
      technical_score: 85.0,
      risk_reward_ratio: 1.8,
      india_vix: 19.5,
      market_regime: "VOLATILE",
      order_flow_imbalance_ratio: 0.3,
    };
    const decision = computeNativeLayaDecision(req);
    expect(decision.action).toBe("LIMIT_PULLBACK");
  });

  it("should compute native System-1 decision directly via computeNativeSystem1Decision", () => {
    const req: System1DecisionRequest = {
      symbol: "DIRECT_TEST",
      direction: "BUY",
      risk_reward_ratio: 2.5,
      technical_score: 85.0,
      india_vix: 13.0,
      market_regime: "BULL_TRENDING",
    };
    const decDefault: LayaDecision = computeNativeSystem1Decision(req);
    expect(decDefault.provider).toBe("laya");
    expect(decDefault.verdict).toBe("APPROVE");

    const decLaya = computeNativeSystem1Decision(req, "laya");
    expect(decLaya.provider).toBe("laya");
    expect(decLaya.verdict).toBe("APPROVE");

    const decJev = computeNativeSystem1Decision(req, "jev");
    expect(decJev.provider).toBe("jev");
    expect(decJev.verdict).toBe("APPROVE");
  });

  it("should re-export canonical System1Decision from laya_contract and jev_contract", async () => {
    const layaModule = await import("./laya_contract");
    const jevModule = await import("./jev_contract");
    expect(layaModule).toBeDefined();
    expect(jevModule).toBeDefined();

    const req: System1DecisionRequest = {
      symbol: "CONTRACT_TEST",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      technical_score: 75.0,
    };
    const decision = computeNativeSystem1Decision(req);
    // TypeScript structural typing compatibility verification
    const asLaya: import("./laya_contract").LayaDecision = decision;
    const asJev: import("./jev_contract").JevDecision = decision;
    expect(asLaya.verdict).toBe(asJev.verdict);
  });

  it("should enforce institutional circuit breakers for short trades and ranker win prob", () => {
    // 1. Learned Ranker win prob < 0.45 gate
    const reqLowRanker: System1DecisionRequest = {
      symbol: "LOW_PROB",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      technical_score: 80.0,
      win_probability: 0.40,
    };
    const decLowRanker = computeNativeLayaDecision(reqLowRanker);
    expect(decLowRanker.verdict).toBe("REJECT");
    expect(decLowRanker.gate_reasons.some((r) => r.includes("LOW_RANKER_WIN_PROB"))).toBe(true);

    // 2. Short trade with heavy FII buying (>2500)
    const reqShortFii: System1DecisionRequest = {
      symbol: "SHORT_FII",
      direction: "SELL",
      risk_reward_ratio: 2.0,
      fii_dii_net: 3000,
    };
    const decShortFii = computeNativeLayaDecision(reqShortFii);
    expect(decShortFii.verdict).toBe("REJECT");
    expect(decShortFii.gate_reasons).toContain("HEAVY_INSTITUTIONAL_BUYING");

    // 3. Short trade with positive OFI contradiction (>0.35)
    const reqShortOfi: System1DecisionRequest = {
      symbol: "SHORT_OFI",
      direction: "SELL",
      risk_reward_ratio: 2.0,
      order_flow_imbalance_ratio: 0.40,
    };
    const decShortOfi = computeNativeLayaDecision(reqShortOfi);
    expect(decShortOfi.verdict).toBe("REJECT");
    expect(decShortOfi.gate_reasons).toContain("SEVERE_ORDER_FLOW_CONTRADICTION");

    // 4. Elevated VIX > 20 counter regime
    const reqVixCounter: System1DecisionRequest = {
      symbol: "COUNTER_VIX",
      direction: "BUY",
      risk_reward_ratio: 2.0,
      india_vix: 22.0,
      market_regime: "BEAR_TRENDING",
    };
    const decVixCounter = computeNativeLayaDecision(reqVixCounter);
    expect(decVixCounter.verdict).toBe("REJECT");
    expect(decVixCounter.gate_reasons).toContain("ELEVATED_VIX_COUNTER_REGIME");
  });

  it("should compute symmetrical OFI confluence for short (SELL) trades in Noul probabilities", () => {
    const baseReq: System1DecisionRequest = {
      symbol: "SHORT_SYM",
      direction: "SELL",
      setup_type: "PULLBACK",
      technical_score: 75.0,
      risk_reward_ratio: 2.2,
      india_vix: 14.0,
      market_regime: "BEAR_TRENDING",
    };

    const decPositiveConfluence = computeNativeLayaDecision({
      ...baseReq,
      order_flow_imbalance_ratio: -0.25, // Favorable to sellers
    });

    const decAdverseConfluence = computeNativeLayaDecision({
      ...baseReq,
      order_flow_imbalance_ratio: 0.25, // Adverse to sellers
    });

    expect(decPositiveConfluence.p_execution_success).toBeGreaterThan(decAdverseConfluence.p_execution_success);
    expect(decPositiveConfluence.gate_reasons).toContain("POSITIVE_ORDER_FLOW_CONFLUENCE");
  });

  it("should support consensus provider evaluation with confidence boost in native surrogate", async () => {
    const req: System1DecisionRequest = {
      symbol: "CONSENSUS_SYM",
      direction: "BUY",
      setup_type: "PULLBACK",
      technical_score: 85.0,
      risk_reward_ratio: 2.5,
      india_vix: 13.5,
      market_regime: "BULL_TRENDING",
      order_flow_imbalance_ratio: 0.2,
    };

    const decConsensus = computeNativeSystem1Decision(req, "consensus");
    expect(decConsensus.provider).toBe("consensus");
    expect(decConsensus.verdict).toBe("APPROVE");
    expect(decConsensus.gate_reasons).toContain("SYSTEM1_DUAL_ENGINE_CONSENSUS");
    expect(decConsensus.source).toBe("native_ts_laya");

    const decSingle = computeNativeSystem1Decision(req, "laya");
    expect(decConsensus.confidence).toBeGreaterThanOrEqual(decSingle.confidence);
    // The async evaluateSystem1Decision consensus path is covered in the
    // "LAYA System-1 offline fallback" block, which pins AI_SERVICE_URL so the
    // native surrogate is exercised deterministically.
  });
});
