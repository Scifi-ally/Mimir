import { Router } from "express";
import { db } from "../../db/src";
import { dailyReportsTable } from "../../db/src/schema/reports";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { buildExpectancyReport } from "../suggestions/expectancy";
import { generateDailyReport } from "../analysis/post_market_report";

const router = Router();

import { eq, desc } from "drizzle-orm";

router.get("/", async (_req, res) => {
  try {
    const reports = await db.select()
      .from(dailyReportsTable)
      .orderBy(desc(dailyReportsTable.date))
      .limit(90);
    res.json(reports);
  } catch (err) {
    logger.error({ err }, "Failed to fetch reports");
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

// GET /api/reports/:date — Fetch report by date or auto-generate if missing
router.get("/by-date/:date", async (req, res) => {
  try {
    const dateStr = req.params.date.trim();
    let existing = await db.select()
      .from(dailyReportsTable)
      .where(eq(dailyReportsTable.date, dateStr))
      .limit(1);

    if (existing.length === 0) {
      // Auto-generate report for this date on-demand
      await generateDailyReport(dateStr);
      existing = await db.select()
        .from(dailyReportsTable)
        .where(eq(dailyReportsTable.date, dateStr))
        .limit(1);
    }

    if (existing.length > 0) {
      res.json(existing[0]);
    } else {
      res.status(404).json({ error: "Report not found" });
    }
  } catch (err) {
    logger.error({ err }, "Failed to fetch or generate report for date");
    res.status(500).json({ error: "Failed to process report for date" });
  }
});

// POST /api/reports/generate — Manually trigger report generation for today or specified date
router.post("/generate", async (req, res) => {
  try {
    const targetDate = req.body?.date ? String(req.body.date) : undefined;
    await generateDailyReport(targetDate);
    res.json({ success: true, message: `Report generated successfully for ${targetDate || 'today'}` });
  } catch (err) {
    logger.error({ err }, "Failed to generate report manually");
    res.status(500).json({ error: "Failed to generate report" });
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
