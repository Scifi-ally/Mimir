import { Router } from "express";
import { getGlobalMacroState } from "../analysis/global_macro";
import { buildMeasuredFactors } from "../analysis/measured_factors";
import { findStockBySymbol, fetchNiftyDailyCandles, resolveSymbolInsightContext } from "../analysis/stock_scanner";
import { logger } from "../lib/logger";

const router = Router();

router.get("/market/factors", (_req, res) => {
  const state = getGlobalMacroState();
  res.json({ asOf: new Date().toISOString(), factors: state.observations ?? {},
    predictiveValidation: "not_established", macroScoreKind: "heuristic_market_stress_proxy" });
});

router.get("/market/factors/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!/^[A-Z0-9&_.-]{1,30}$/.test(symbol)) { res.status(400).json({ error: "Invalid symbol" }); return; }
  try {
    const stock = await findStockBySymbol(symbol);
    if (!stock) { res.status(404).json({ error: "Unknown equity symbol" }); return; }
    const benchmark = await fetchNiftyDailyCandles(70);
    const context = await resolveSymbolInsightContext(stock, benchmark, true);
    const snapshot = buildMeasuredFactors(symbol, context?.candles ?? [], undefined,
      getGlobalMacroState().observations ?? {});
    res.json({ ...snapshot, available: snapshot.coverage.available > 0,
      limitations: ["Coverage does not establish predictive value", "No verified fundamental/news/depth factors supplied"] });
  } catch (error) {
    logger.warn({ error, symbol }, "Measured-factor request failed");
    res.status(503).json({ available: false, error: "Factor data unavailable" });
  }
});

export default router;
