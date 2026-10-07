import { Router } from "express";
import { requireAdmin } from "../lib/security";
import { logger } from "../lib/logger";
import { readStrategyReport, readExchangeArchiveStatus, readExchangeBackfillStatus, readCorporateArchiveStatus, readStrategyAdmission, readDeliveryCostStudy, runStrategyJob, strategyLabState, readEtfRotationStudy, readEtfRotationSignal, runEtfSignalJob } from "../analysis/strategy_lab";

const router = Router();
router.get("/research/etf-rotation", requireAdmin, async (_req, res) => {
  try {
    const study = await readEtfRotationStudy();
    res.json({ report: study, mode: "etf_dual_momentum_rotation", liveAdmitted: false });
  } catch (err) {
    logger.warn({ err }, "ETF rotation research unavailable");
    res.status(503).json({ error: "ETF rotation research unavailable", liveAdmitted: false });
  }
});
router.get("/research/etf-signal", requireAdmin, async (_req, res) => {
  try {
    let sig = await readEtfRotationSignal();
    if (!sig) {
      sig = await runEtfSignalJob();
    }
    res.json({ signal: sig, mode: "research_signal" });
  } catch (err) {
    logger.warn({ err }, "ETF rotation signal unavailable");
    res.status(503).json({ error: "ETF rotation signal unavailable" });
  }
});
router.post("/research/etf-signal/refresh", requireAdmin, async (req, res) => {
  try {
    const capital = typeof req.body?.capital === "number" ? req.body.capital : undefined;
    const sig = await runEtfSignalJob(capital);
    const { syncEtfSuggestionToEngine } = await import("../analysis/etf_suggestion_service");
    const syncRes = await syncEtfSuggestionToEngine(capital);
    res.json({ success: true, signal: sig, engineSync: syncRes });
  } catch (err) {
    logger.warn({ err }, "Failed to refresh ETF rotation signal");
    res.status(500).json({ error: "Failed to refresh ETF signal", details: String(err) });
  }
});
router.get("/research/delivery-costs", requireAdmin, async (_req, res) => {
  try { res.json({ report: await readDeliveryCostStudy(), mode: "exploratory_cost_comparison", liveAdmitted: false }); }
  catch { res.status(503).json({ error: "Delivery cost research unavailable", liveAdmitted: false }); }
});
router.get("/research/data", requireAdmin, async (_req, res) => {
  try { res.json({ ...strategyLabState(), archive: await readExchangeArchiveStatus(), corporateActions: await readCorporateArchiveStatus(), backfill: await readExchangeBackfillStatus() }); }
  catch { res.status(503).json({ error: "Exchange evidence unavailable", liveAdmitted: false }); }
});
router.post("/research/data/collect", requireAdmin, (_req, res) => {
  if (strategyLabState().running) { res.status(409).json({ error: "Strategy worker already running" }); return; }
  void runStrategyJob("archive").catch(error => logger.warn({ error: String(error) }, "Exchange archive job failed"));
  res.status(202).json({ accepted: true, mode: "archive", liveAdmitted: false });
});
router.get("/research/strategies", requireAdmin, async (_req, res) => {
  try { res.json({ ...strategyLabState(), report: await readStrategyReport(), forward: await readStrategyReport(true), admission: await readStrategyAdmission() }); }
  catch { res.status(503).json({ error: "Research evidence unavailable", liveAdmitted: false }); }
});
for (const mode of ["research", "forward"] as const) {
  router.post(`/research/strategies/${mode}`, requireAdmin, (_req, res) => {
    if (strategyLabState().running) { res.status(409).json({ error: "Strategy worker already running" }); return; }
    // Request fields never become shell arguments, filesystem paths or trading capital.
    void runStrategyJob(mode).catch(error => logger.warn({ error: String(error) }, "Strategy job failed"));
    res.status(202).json({ accepted: true, mode, liveAdmitted: false });
  });
}
export default router;
