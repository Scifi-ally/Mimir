import { Router } from "express";
import { db } from "../../db/src";
import { dailyReportsTable } from "../../db/src/schema/reports";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { buildExpectancyReport } from "../suggestions/expectancy";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const reports = await db.select()
      .from(dailyReportsTable)
      .orderBy(desc(dailyReportsTable.date))
      .limit(30);
    res.json(reports);
  } catch (err) {
    logger.error({ err }, "Failed to fetch reports");
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// GET /api/reports/expectancy?days=60 — realized edge per trade in R after costs
router.get("/expectancy", async (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 60));
    const report = await buildExpectancyReport(days);
    res.json(report);
  } catch (err) {
    logger.error({ err }, "Failed to build expectancy report");
    res.status(500).json({ error: "Failed to build expectancy report" });
  }
});

export const reportsRouter = router;
