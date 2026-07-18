import { Router } from "express";
import { getMarketState, computeSessionPhase, minutesUntilOpen } from "../market_data/market_state";
import { getMarketFeedSnapshot } from "../market_data/market_feed";
import { getMarketIntelligenceSnapshot } from "../intelligence/orchestrator";
import { getGlobalMacroState } from "../analysis/global_macro";
import { fetchFIIDIIData } from "../market_data/fii_dii";
import { fetchOptionChainData } from "../market_data/option_chain";
import { logApiError } from "../lib/api-errors";
import { getGapRisk, getTodayEconomicEvent } from "../analysis/gap_risk";
import { getInternalsSnapshot } from "../analysis/market_internals";

const router = Router();

// GET /api/market/regime
router.get("/market/regime", async (_req, res) => {
  const state = getMarketState();
  const phase = computeSessionPhase();
  const marketOpen = phase === "MARKET";
  const minsUntilOpen = minutesUntilOpen();

  res.json({
    regime: state.regime,
    sessionPhase: phase,
    isMarketOpen: marketOpen,
    minutesUntilOpen: minsUntilOpen,
    indiaVix: state.indiaVix,
    niftyChange: state.niftyChangePct,
    updatedAt: state.updatedAt.toISOString(),
    suggestionsPaused: state.suggestionsPaused,
    pauseReason: state.pauseReason,
    decisionReason: state.decisionReason ?? "Calculating...",
    inputsForced: state.inputsForced ?? false,
  });
});

// GET /api/market/overview
router.get("/market/overview", async (_req, res) => {
  const state = getMarketState();
  const feed = getMarketFeedSnapshot();
  const intelligence = getMarketIntelligenceSnapshot();
  const breadth = intelligence.breadth;
  const sectorStrength = breadth?.sectorStrength ?? {};
  const topSectors = state.topSectors.length
    ? state.topSectors
    : Object.entries(sectorStrength)
        .map(([name, changePct]) => ({ name, changePct: Number(changePct) }))
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, 8);
  const phase = computeSessionPhase();
  res.json({
    niftyPrice: state.niftyPrice,
    niftyChangePct: state.niftyChangePct,
    advanceCount: state.advanceCount || breadth?.advancers || 0,
    declineCount: state.declineCount || breadth?.decliners || 0,
    topSectors,
    fiiNetInr: state.fiiNetInr,
    diiNetInr: state.diiNetInr,
    isMarketOpen: phase === "MARKET",
    marketOpenTime: "09:15",
    marketCloseTime: "15:30",
    upstoxFeed: feed,
  });
});

// GET /api/market/indian-context
router.get("/market/indian-context", async (_req, res) => {
  try {
    const fiiDii = await fetchFIIDIIData();
    const optionChain = await fetchOptionChainData();
    const macroData = getGlobalMacroState();

    res.json({
      // null = data unavailable; frontend renders N/A. Never send fabricated numbers.
      fiiDii: fiiDii ?? null,
      niftyOptionChain: optionChain ?? null,
      usdInr: macroData.usdInr,
      india10y: macroData.india10y,
      india10yIsEstimate: macroData.india10yIsEstimate,
      macroScore: macroData.macroScore,
      eventRiskActive: macroData.eventRiskActive ?? false,
      economicEvent: getTodayEconomicEvent(),
      gapRisk: getGapRisk(),
      internals: getInternalsSnapshot(),
      lastUpdated: new Date().toISOString()
    });
  } catch (err: unknown) {
    logApiError(_req, err);
    res.status(500).json({ error: "Failed to fetch indian context" });
  }
});

// GET /api/market/macro
router.get("/market/macro", (req, res) => {
  try {
    const macroState = getGlobalMacroState();
    res.json(macroState);
  } catch (err: unknown) {
    logApiError(req, err);
    res.status(500).json({ error: "Failed to fetch macro state" });
  }
});

export default router;
