import { Router } from "express";
import { getAlertHistory } from "../analysis/alerts";
import { logger } from "../lib/logger";

const router = Router();

router.get("/alerts/history", async (_req, res) => {
  try {
    const history = await getAlertHistory();
    res.json(history);
  } catch (err) {
    logger.error({ err }, "Failed to fetch alert history");
    res.status(500).json({ error: "Failed to fetch alert history" });
  }
});

export default router;
