import { getMarketState, type MarketState, type SessionPhase } from "../market_data/market_state";

export type IndiaDataQuality = "FULL" | "PARTIAL" | "UNAVAILABLE";

export interface IndiaMarketContext {
  regime: MarketState["regime"];
  sessionPhase: SessionPhase;
  marketOpen: boolean;
  indiaVix: number | null;
  breadthPct: number | null;
  sectorBreadthPct: number | null;
  fiiNetInr: number | null;
  diiNetInr: number | null;
  netInstitutionalFlowInr: number | null;
  macroScore: number;
  eventRiskActive: boolean;
  geopoliticalRisk: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  dataQuality: IndiaDataQuality;
  updatedAt: string;
}

export interface IndiaMacroState {
  indiaVix?: number | null;
  fiiNetInr?: number | null;
  diiNetInr?: number | null;
  macroScore?: number;
  eventRiskActive?: boolean;
  geopoliticalRisk?: "LOW" | "MODERATE" | "HIGH" | "EXTREME";
  lastUpdated?: string | null;
}

export interface IndiaTradeabilityThresholds {
  minDailyVolume: number;
  minDailyTurnoverInr: number;
}

export const DEFAULT_INDIA_TRADEABILITY_THRESHOLDS: IndiaTradeabilityThresholds = {
  minDailyVolume: 500_000,
  minDailyTurnoverInr: 50_000_000,
};

export interface IndiaTradeabilityInput {
  price: number;
  avgDailyVolume: number;
  atrPct: number;
  volumeRatio: number;
  sectorChangePct?: number | null;
  sessionPhase?: SessionPhase;
  marketOpen?: boolean;
  marketState?: IndiaMarketContext;
}

export interface IndiaTradeabilityResult {
  accepted: boolean;
  score: number;
  riskMultiplier: number;
  capacityInr: number;
  estimatedImpactBps: number;
  reasons: string[];
  warnings: string[];
  dataQuality: IndiaDataQuality;
}

export interface IndiaSignalAdjustment {
  adjustment: number;
  reasons: string[];
  riskMultiplier: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sectorBreadth(topSectors: MarketState["topSectors"]): number | null {
  if (topSectors.length === 0) return null;
  return (topSectors.filter((sector) => sector.changePct > 0).length / topSectors.length) * 100;
}

export function buildIndiaMarketContext(
  state: MarketState = getMarketState(),
  macro: IndiaMacroState = {},
): IndiaMarketContext {
  const breadthTotal = state.advanceCount + state.declineCount;
  const breadthPct = breadthTotal > 0 ? (state.advanceCount / breadthTotal) * 100 : null;
  const sectorBreadthPct = sectorBreadth(state.topSectors);
  const fiiNetInr = finiteOrNull(state.fiiNetInr ?? macro.fiiNetInr);
  const diiNetInr = finiteOrNull(state.diiNetInr ?? macro.diiNetInr);
  const hasCoreMarketData = state.niftyChangePct !== null || state.indiaVix !== null || breadthPct !== null;
  const hasInstitutionalData = fiiNetInr !== null || diiNetInr !== null;
  const hasMacroData = macro.lastUpdated != null;

  let dataQuality: IndiaDataQuality = "UNAVAILABLE";
  if (hasCoreMarketData && hasInstitutionalData && hasMacroData) dataQuality = "FULL";
  else if (hasCoreMarketData || hasInstitutionalData || hasMacroData) dataQuality = "PARTIAL";

  return {
    regime: state.regime,
    sessionPhase: state.sessionPhase,
    marketOpen: state.isMarketOpen,
    indiaVix: finiteOrNull(state.indiaVix ?? macro.indiaVix),
    breadthPct,
    sectorBreadthPct,
    fiiNetInr,
    diiNetInr,
    netInstitutionalFlowInr:
      fiiNetInr !== null || diiNetInr !== null ? (fiiNetInr ?? 0) + (diiNetInr ?? 0) : null,
    macroScore: clamp(Number.isFinite(macro.macroScore ?? 0) ? (macro.macroScore ?? 0) : 0, -100, 100),
    eventRiskActive: macro.eventRiskActive === true,
    geopoliticalRisk: macro.geopoliticalRisk ?? "LOW",
    dataQuality,
    updatedAt: macro.lastUpdated ?? (state.updatedAt instanceof Date ? state.updatedAt.toISOString() : new Date(0).toISOString()),
  };
}

/**
 * Cost-aware India tradeability gate. It deliberately uses only fields that
 * Mimir currently has reliably available. Quote-level spread and depth can be
 * supplied later without changing this contract.
 */
export function evaluateIndiaTradeability(
  input: IndiaTradeabilityInput,
  context: IndiaMarketContext = buildIndiaMarketContext(),
  thresholds: IndiaTradeabilityThresholds = DEFAULT_INDIA_TRADEABILITY_THRESHOLDS,
): IndiaTradeabilityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  const validPrice = Number.isFinite(input.price) && input.price > 0;
  const validVolume = Number.isFinite(input.avgDailyVolume) && input.avgDailyVolume > 0;
  const turnoverInr = validPrice && validVolume ? input.price * input.avgDailyVolume : 0;

  if (!validPrice || !validVolume) {
    return {
      accepted: false,
      score: 0,
      riskMultiplier: 0,
      capacityInr: 0,
      estimatedImpactBps: Infinity,
      reasons: ["missing price or average-volume data"],
      warnings,
      dataQuality: "UNAVAILABLE",
    };
  }

  if (input.avgDailyVolume < thresholds.minDailyVolume) {
    reasons.push(`average volume below ${thresholds.minDailyVolume.toLocaleString()}`);
    score -= 45;
  }
  if (turnoverInr < thresholds.minDailyTurnoverInr) {
    reasons.push(`average turnover below ₹${(thresholds.minDailyTurnoverInr / 1e7).toFixed(1)}cr`);
    score -= 35;
  }

  const atrPct = Number.isFinite(input.atrPct) ? input.atrPct : 0;
  if (atrPct > 7.5) {
    reasons.push(`ATR volatility ${atrPct.toFixed(2)}% is too high for normal execution`);
    score -= 30;
  } else if (atrPct < 0.6) {
    warnings.push(`ATR volatility ${atrPct.toFixed(2)}% is low; expected edge may not cover costs`);
    score -= 10;
  }

  const volumeRatio = Number.isFinite(input.volumeRatio) ? input.volumeRatio : 0;
  if (volumeRatio < 0.5) {
    warnings.push("current participation is below half of the recent baseline");
    score -= 12;
  } else if (volumeRatio >= 1.5) {
    score += 4;
  }

  if (input.sectorChangePct !== null && input.sectorChangePct !== undefined) {
    if (Math.abs(input.sectorChangePct) > 4) {
      warnings.push("sector is in an extreme move; gap and reversal risk are elevated");
      score -= 8;
    }
  }

  if (context.eventRiskActive) {
    warnings.push("India-relevant macro event risk is active");
    score -= 12;
  }
  if (context.geopoliticalRisk === "EXTREME") {
    warnings.push("composite India/global risk state is extreme");
    score -= 18;
  } else if (context.geopoliticalRisk === "HIGH") {
    warnings.push("composite India/global risk state is high");
    score -= 10;
  }

  if (context.dataQuality === "UNAVAILABLE") {
    warnings.push("market-state provenance is unavailable; only hard liquidity checks are trusted");
  } else if (context.dataQuality === "PARTIAL") {
    warnings.push("market-state provenance is partial; regime modifiers are conservative");
  }

  const safeTurnover = Math.max(turnoverInr, 0);
  const estimatedImpactBps = safeTurnover > 0
    ? clamp(180 / Math.sqrt(safeTurnover / 1e7), 2, 80)
    : Infinity;
  const capacityInr = safeTurnover * 0.01;
  score -= clamp(estimatedImpactBps - 8, 0, 25);
  score = Math.round(clamp(score, 0, 100));

  const riskMultiplier = context.eventRiskActive
    ? (context.geopoliticalRisk === "EXTREME" ? 0.35 : 0.6)
    : context.geopoliticalRisk === "HIGH" ? 0.7 : 1;

  const accepted = reasons.length === 0 && score >= 55;
  return {
    accepted,
    score,
    riskMultiplier,
    capacityInr: Math.round(capacityInr * 100) / 100,
    estimatedImpactBps: Math.round(estimatedImpactBps * 100) / 100,
    reasons,
    warnings,
    dataQuality: context.dataQuality,
  };
}

/**
 * Direction-aware market/sector alignment adjustment. This is deliberately a
 * small additive adjustment; it cannot override hard risk checks.
 */
export function computeIndiaSignalAdjustment(
  direction: "BUY" | "SELL",
  sectorChangePct: number | null | undefined,
  context: IndiaMarketContext = buildIndiaMarketContext(),
): IndiaSignalAdjustment {
  const reasons: string[] = [];
  let adjustment = 0;
  let riskMultiplier = context.eventRiskActive ? 0.6 : 1;

  if (context.breadthPct !== null) {
    const breadthAligned = direction === "BUY" ? context.breadthPct >= 55 : context.breadthPct <= 45;
    const breadthOpposed = direction === "BUY" ? context.breadthPct <= 40 : context.breadthPct >= 60;
    if (breadthAligned) {
      adjustment += 0.25;
      reasons.push("market breadth confirms direction");
    } else if (breadthOpposed) {
      adjustment -= 0.35;
      reasons.push("market breadth opposes direction");
    }
  }

  if (sectorChangePct !== null && sectorChangePct !== undefined && Number.isFinite(sectorChangePct)) {
    const sectorAligned = direction === "BUY" ? sectorChangePct > 0 : sectorChangePct < 0;
    const sectorOpposed = direction === "BUY" ? sectorChangePct < -1 : sectorChangePct > 1;
    if (sectorAligned) {
      adjustment += 0.2;
      reasons.push("sector direction confirms trade");
    } else if (sectorOpposed) {
      adjustment -= 0.3;
      reasons.push("sector direction opposes trade");
    }
  }

  if (context.netInstitutionalFlowInr !== null) {
    const flowAligned = direction === "BUY" ? context.netInstitutionalFlowInr > 0 : context.netInstitutionalFlowInr < 0;
    if (flowAligned) {
      adjustment += 0.15;
      reasons.push("net institutional flow confirms direction");
    } else {
      adjustment -= 0.15;
      reasons.push("net institutional flow opposes direction");
    }
  }

  if (context.macroScore !== 0) {
    const macroAligned = direction === "BUY" ? context.macroScore > 10 : context.macroScore < -10;
    if (macroAligned) adjustment += 0.1;
    else if ((direction === "BUY" && context.macroScore < -25) || (direction === "SELL" && context.macroScore > 25)) adjustment -= 0.2;
  }

  if (context.geopoliticalRisk === "EXTREME") riskMultiplier = Math.min(riskMultiplier, 0.35);
  else if (context.geopoliticalRisk === "HIGH") riskMultiplier = Math.min(riskMultiplier, 0.7);

  return { adjustment, reasons, riskMultiplier };
}
