import { Router, type IRouter } from "express";
import { getAlertHistory } from "../analysis/alerts";

const router: IRouter = Router();

router.get("/alerts/history", async (_req, res) => {
  try {
    const alerts = await getAlertHistory();
    const mappedAlerts = alerts.map((a: any) => ({
      ...a,
      createdAt: a.createdAt || a.timestamp
    }));
    res.json(mappedAlerts);
  } catch (err) {
    res.status(500).json({ status: "error", error: "Failed to fetch alert history" });
  }
});

export default router;
