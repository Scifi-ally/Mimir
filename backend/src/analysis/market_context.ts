import { getConfig } from "../config";
import { getMarketState } from "../market_data/market_state";
import { getGlobalMacroState } from "./global_macro";
import { getOptionsSentimentState } from "./options_sentiment";
import type { ScanResult } from "./stock_scanner";

export interface MarketContextDecision {
  accepted: boolean;
  effectiveScore: number;
  adjustment: number;
  notes: string[];
  blockers: string[];
}

export function evaluateMarketContext(result: ScanResult): MarketContextDecision {
  const state = getMarketState();
  const macro = getGlobalMacroState();
  const options = getOptionsSentimentState();
  const cfg = getConfig();
  const direction = result.setup.direction;
  const notes: string[] = [];
  const blockers: string[] = [];
  let adjustment = 0;

  // 1. Global Macro Integration
  if (macro.eventRiskActive && direction === "BUY") {
    adjustment -= 1.0;
    notes.push("Macro event risk active (high yield/DXY)");
  }
  if (macro.macroScore < -50 && direction === "BUY") {
    blockers.push("Severe bearish global macro forces");
  } else if (macro.macroScore > 50 && direction === "BUY") {
    adjustment += 0.5;
    notes.push("Strong bullish global macro tailwinds");
  }

  // 2. Options Sentiment Integration
  if (options.pcr != null) {
    if (options.pcr > 1.5 && direction === "BUY") {
      adjustment -= 2.0;
      notes.push(`Extreme overbought PCR: ${options.pcr}`);
    } else if (options.pcr < 0.6 && direction === "SELL") {
      adjustment -= 2.0;
      notes.push(`Extreme oversold PCR: ${options.pcr}`);
    }
  }

  // 3. Local Market Factors (India VIX, Nifty, Breadth, FII)
  if (state.indiaVix != null) {
    const vixRatio = state.indiaVix / cfg.vixPauseThreshold;
    if (vixRatio >= 1) blockers.push(`VIX ${state.indiaVix.toFixed(1)} above limit`);
    else if (vixRatio >= 0.85) {
      adjustment -= 0.55;
      notes.push(`high VIX ${state.indiaVix.toFixed(1)}`);
    } else if (vixRatio <= 0.65) {
      adjustment += 0.2;
      notes.push("calm VIX");
    }
  }

  if (state.niftyChangePct != null) {
    if (direction === "BUY" && state.niftyChangePct < -0.35) blockers.push("Nifty weak");
    if (direction === "SELL" && state.niftyChangePct > 0.35) blockers.push("Nifty strong");
    if (direction === "BUY" && state.niftyChangePct > 0.25) adjustment += 0.35;
    if (direction === "SELL" && state.niftyChangePct < -0.25) adjustment += 0.35;
  }

  const breadthTotal = state.advanceCount + state.declineCount;
  if (breadthTotal >= 20) {
    const advancePct = state.advanceCount / breadthTotal;
    if (direction === "BUY" && advancePct < 0.38) blockers.push("weak market breadth");
    if (direction === "SELL" && advancePct > 0.62) blockers.push("strong market breadth");
    if (direction === "BUY" && advancePct > 0.58) adjustment += 0.35;
    if (direction === "SELL" && advancePct < 0.42) adjustment += 0.35;
    notes.push(`breadth ${(advancePct * 100).toFixed(0)}%`);
  }

  if (state.fiiNetInr != null) {
    if (direction === "BUY" && state.fiiNetInr > 1500) adjustment += 0.25;
    if (direction === "SELL" && state.fiiNetInr < -1500) adjustment += 0.25;
    if (direction === "BUY" && state.fiiNetInr < -2500) adjustment -= 0.45;
    if (direction === "SELL" && state.fiiNetInr > 2500) adjustment -= 0.45;
  }

  if (state.regime === "RANGING" && result.setup.setupType.includes("MOMENTUM")) {
    adjustment -= 0.45;
    notes.push("ranging regime");
  }

  if (state.regime === "TRENDING_UP" && direction === "BUY") adjustment += 0.35;
  if (state.regime === "TRENDING_DOWN" && direction === "SELL") adjustment += 0.35;

  const sector = result.sector;
  const sectorData = state.topSectors.find(s => s.name === sector);
  if (sectorData) {
    if (direction === "BUY" && sectorData.changePct < -0.4) blockers.push(`${sector} sector weak`);
    if (direction === "SELL" && sectorData.changePct > 0.4) blockers.push(`${sector} sector strong`);
    if (direction === "BUY" && sectorData.changePct > 0.4) adjustment += 0.25;
    if (direction === "SELL" && sectorData.changePct < -0.4) adjustment += 0.25;
    notes.push(`${sector} ${sectorData.changePct.toFixed(1)}%`);
  }

  const effectiveScore = Math.min(10, Math.max(0, result.score + adjustment));
  return {
    accepted: blockers.length === 0,
    effectiveScore,
    adjustment,
    notes,
    blockers,
  };
}
