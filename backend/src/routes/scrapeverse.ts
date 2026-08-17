import { Router } from "express";
import { logApiError, sendFallback } from "../lib/api-errors";
import { getScrapeverseCollectorHealth, getScrapeverseFiiDiiLatest } from "../scrapeverse/fii_dii_service";

const router = Router();

router.get("/scrapeverse/fii-dii/latest", async (_req, res) => {
  try {
    const rows = await getScrapeverseFiiDiiLatest();
    res.json({ source: "NSE_FII_DII_CAPITAL_MARKET", rows });
  } catch (error) {
    logApiError(_req, error);
    sendFallback(res, { source: "NSE_FII_DII_CAPITAL_MARKET", rows: [] }, "scrapeverse-fii-dii-error");
  }
});

router.get("/scrapeverse/fii-dii/health", async (_req, res) => {
  try {
    res.json(await getScrapeverseCollectorHealth());
  } catch (error) {
    logApiError(_req, error);
    sendFallback(res, {
      configured: false,
      collectorId: null,
      sourceUrl: "https://www.nseindia.com/reports/fii-dii",
      lastRun: null,
      recentRunCount: 0,
      recentSuccessCount: 0,
      recentCompletenessRate: null,
    }, "scrapeverse-health-error");
  }
});

export default router;
