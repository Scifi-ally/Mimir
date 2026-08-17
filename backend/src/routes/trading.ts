/**
 * Paper-only trading compatibility routes.
 *
 * Mimir is permanently signal-only: market data may be read from Upstox, but
 * no endpoint can arm live mode, fetch live-account state, or place broker
 * orders. These routes remain as explicit compatibility responses for older
 * clients rather than silently pretending that live mode exists.
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PAPER_ONLY_ERROR =
  "Mimir is permanently paper-only; broker order execution is disabled.";

// Legacy read endpoint: return a stable paper-only status without touching the
// broker or exposing a live-mode arming phrase.
router.get("/trading/mode", (_req, res) => {
  res.json({
    mode: "PAPER",
    liveActive: false,
    brokerAuthenticated: false,
    paperOnly: true,
  });
});

// Legacy write endpoint: reject every requested mode, including PAPER, so the
// frontend cannot accidentally revive a removed live-mode workflow.
router.post("/trading/mode", (req, res) => {
  logger.warn({ requestedMode: req.body?.mode }, PAPER_ONLY_ERROR);
  res.status(410).json({ error: PAPER_ONLY_ERROR, paperOnly: true });
});

for (const path of [
  "/trading/live/positions",
  "/trading/live/funds",
  "/trading/live/orders",
]) {
  router.get(path, (_req, res) => {
    res.status(410).json({ error: PAPER_ONLY_ERROR, paperOnly: true });
  });
}

export default router;
