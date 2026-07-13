import { Router } from "express";
import { db } from "../../db/src";
import { dailyReportsTable } from "../../db/src/schema/reports";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";

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

export const reportsRouter = router;
