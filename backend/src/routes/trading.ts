/**
 * Trading Mode & Live Broker Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Switching to LIVE is intentionally NOT part of PATCH /config — real-money
 * arming requires its own endpoint with an explicit confirmation phrase, an
 * authenticated broker session, and it broadcasts the mode change to all
 * clients. Disarming back to PAPER is always allowed and instant.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { getConfig, updateConfig } from "../config";
import { getAccessToken } from "../upstox/auth";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { logger } from "../lib/logger";
import {
  fetchBrokerPositions,
  fetchBrokerFunds,
  getLiveOrderHistory,
  isLiveModeActive,
} from "../trading/broker_orders";

const router: IRouter = Router();

const ARM_PHRASE = "ENABLE LIVE TRADING";

const SetModeBody = z.object({
  mode: z.enum(["PAPER", "LIVE"]),
  // Required when arming LIVE: the user must type the phrase exactly.
  confirmationPhrase: z.string().optional(),
});

// GET /api/trading/mode — current mode + broker readiness
router.get("/trading/mode", async (_req, res) => {
  const cfg = getConfig();
  const brokerAuthenticated = !!getAccessToken("trading");
  res.json({
    mode: cfg.tradingMode,
    liveActive: isLiveModeActive(),
    brokerAuthenticated,
    armPhrase: ARM_PHRASE, // the UI shows what must be typed
  });
});

// POST /api/trading/mode — switch mode
router.post("/trading/mode", async (req, res) => {
  const parsed = SetModeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const { mode, confirmationPhrase } = parsed.data;

  try {
    if (mode === "LIVE") {
      // Arming requirements — every one is a hard stop.
      if (confirmationPhrase !== ARM_PHRASE) {
        res.status(400).json({ error: `Confirmation phrase required. Type exactly: "${ARM_PHRASE}"` });
        return;
      }
      if (!getAccessToken("trading")) {
        res.status(409).json({ error: "Broker not connected. Authenticate with Upstox first (Settings → Broker)." });
        return;
      }
      const funds = await fetchBrokerFunds();
      if (!funds) {
        res.status(409).json({ error: "Could not verify broker funds. Check the Upstox connection and try again." });
        return;
      }

      await updateConfig({ tradingMode: "LIVE", paperTradingEnabled: false });
      logger.warn({ availableMargin: funds.availableMargin }, "LIVE TRADING ARMED");
      broadcast(createServerEvent.systemAlert({
        message: `LIVE trading armed. Available margin: ₹${Math.round(funds.availableMargin).toLocaleString("en-IN")}. All engine fills will now place real orders.`,
        severity: "warning",
      }), "system");
      res.json({ mode: "LIVE", liveActive: true, availableMargin: funds.availableMargin });
    } else {
      await updateConfig({ tradingMode: "PAPER", paperTradingEnabled: true });
      logger.info("Trading disarmed back to PAPER mode");
      broadcast(createServerEvent.systemAlert({
        message: "Live trading disarmed. Engine is back in paper mode — no real orders will be placed.",
        severity: "info",
      }), "system");
      res.json({ mode: "PAPER", liveActive: false });
    }
  } catch (err) {
    logger.error({ err, mode }, "Failed to switch trading mode");
    res.status(500).json({ error: "Failed to switch trading mode" });
  }
});

// GET /api/trading/live/positions — real positions from the broker
router.get("/trading/live/positions", async (_req, res) => {
  if (getConfig().tradingMode !== "LIVE") {
    res.status(409).json({ error: "Not in LIVE mode" });
    return;
  }
  const positions = await fetchBrokerPositions();
  if (positions === null) {
    res.status(502).json({ error: "Failed to fetch broker positions" });
    return;
  }
  res.json(positions);
});

// GET /api/trading/live/funds — real margin from the broker
router.get("/trading/live/funds", async (_req, res) => {
  if (getConfig().tradingMode !== "LIVE") {
    res.status(409).json({ error: "Not in LIVE mode" });
    return;
  }
  const funds = await fetchBrokerFunds();
  if (funds === null) {
    res.status(502).json({ error: "Failed to fetch broker funds" });
    return;
  }
  res.json(funds);
});

// GET /api/trading/live/orders — audit trail of real orders
router.get("/trading/live/orders", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const orders = await getLiveOrderHistory(limit);
    res.json(orders);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch live order history");
    res.status(500).json({ error: "Failed to fetch live orders" });
  }
});

export default router;
