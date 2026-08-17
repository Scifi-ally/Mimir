import { describe, expect, it } from "vitest";
import { buildIndiaMarketContext, computeIndiaSignalAdjustment, evaluateIndiaTradeability } from "./india_market_state";
import type { GlobalMacroState } from "./global_macro";
import type { MarketState } from "../market_data/market_state";

const baseMarketState: MarketState = {
  regime: "TRENDING_UP",
  sessionPhase: "MARKET",
  niftyPrice: 22_000,
  niftyChangePct: 0.5,
  indiaVix: 14,
  advanceCount: 120,
  declineCount: 80,
  advancingVolume: 1_000_000,
  decliningVolume: 600_000,
  upTickCount: 100,
  downTickCount: 80,
  topSectors: [{ name: "IT", changePct: 0.8 }],
  updatedAt: new Date("2026-08-17T09:30:00.000Z"),
  suggestionsPaused: false,
  pauseReason: null,
  isMarketOpen: true,
  fiiNetInr: 1500,
  diiNetInr: 500,
  corporateActionSymbols: new Set(),
};

const baseMacro: GlobalMacroState = {
  us10YearYield: 4.1,
  dxy: 103,
  brentCrude: 80,
  usdInr: 86,
  india10y: 6.9,
  india10yIsEstimate: true,
  indiaVix: 14,
  fiiNetInr: 1500,
  diiNetInr: 500,
  macroScore: 10,
  eventRiskActive: false,
  geopoliticalRisk: "LOW",
  lastUpdated: "2026-08-17T09:30:00.000Z",
};

describe("India market state", () => {
  it("builds full provenance when core, institutional, and macro inputs exist", () => {
    const context = buildIndiaMarketContext(baseMarketState, baseMacro);
    expect(context.dataQuality).toBe("FULL");
    expect(context.breadthPct).toBe(60);
    expect(context.netInstitutionalFlowInr).toBe(2000);
  });

  it("does not fabricate unavailable market state", () => {
    const state = { ...baseMarketState, niftyChangePct: null, indiaVix: null, advanceCount: 0, declineCount: 0, fiiNetInr: null, diiNetInr: null };
    const macro = { ...baseMacro, macroScore: 0, lastUpdated: null, fiiNetInr: null, diiNetInr: null, indiaVix: null };
    const context = buildIndiaMarketContext(state, macro);
    expect(context.dataQuality).toBe("UNAVAILABLE");
    expect(context.breadthPct).toBeNull();
    expect(context.netInstitutionalFlowInr).toBeNull();
  });

  it("rejects a trade whose turnover is below the configured Indian minimum", () => {
    const result = evaluateIndiaTradeability({
      price: 100,
      avgDailyVolume: 10_000,
      atrPct: 2,
      volumeRatio: 1,
    }, buildIndiaMarketContext(baseMarketState, baseMacro));
    expect(result.accepted).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("turnover"))).toBe(true);
  });

  it("reduces risk in an extreme event state without fabricating directional edge", () => {
    const context = buildIndiaMarketContext(baseMarketState, {
      ...baseMacro,
      eventRiskActive: true,
      geopoliticalRisk: "EXTREME",
    });
    const result = evaluateIndiaTradeability({
      price: 1000,
      avgDailyVolume: 2_000_000,
      atrPct: 2,
      volumeRatio: 1.2,
    }, context);
    expect(result.accepted).toBe(true);
    expect(result.riskMultiplier).toBe(0.35);
    expect(result.warnings.some((warning) => warning.includes("event risk"))).toBe(true);
  });

  it("adds confirmation when breadth, sector, and institutional flow align", () => {
    const adjustment = computeIndiaSignalAdjustment("BUY", 1.2, buildIndiaMarketContext(baseMarketState, baseMacro));
    expect(adjustment.adjustment).toBeGreaterThan(0);
    expect(adjustment.reasons.length).toBeGreaterThan(0);
  });
});
