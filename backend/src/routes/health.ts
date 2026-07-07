import { Router, type IRouter } from "express";
import { db } from "../../db/src";
import { sql } from "drizzle-orm";
import { upstoxConnectionManager } from "../intelligence/connection_manager";
import { intelligenceWorkerPools } from "../intelligence/worker_pool";
import { logger } from "../lib/logger";
import { tickDistribution } from "../market_data/tick_distribution";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/health/diagnostics", (_req, res) => {
  res.json({
    status: "ok",
    marketData: tickDistribution.getDiagnostics(),
    timestamp: new Date().toISOString(),
  });
});

router.get("/health", async (req, res) => {
  let dbStatus = "disconnected";
  try {
    await db.execute(sql`SELECT 1`);
    dbStatus = "connected";
  } catch (err) {
    (req.log || logger).error({ err }, "Healthcheck DB check failed");
  }

  const feedStatus = upstoxConnectionManager.getStatus();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pools: Record<string, any> = {};
  let allPoolsHealthy = true;

  for (const [key, pool] of Object.entries(intelligenceWorkerPools)) {
    const health = pool.getHealth();
    pools[key] = health;
    if (!health.healthy) {
      allPoolsHealthy = false;
    }
  }

  const systemStatus =
    dbStatus === "connected" && feedStatus.connected && allPoolsHealthy
      ? "ok"
      : "degraded";

  res.json({
    status: systemStatus,
    database: dbStatus,
    upstoxFeed: feedStatus,
    marketDataTelemetry: tickDistribution.getDiagnostics(),
    workerPools: pools,
    lastTickReceivedAt: feedStatus.lastTickReceivedAt > 0 
      ? new Date(feedStatus.lastTickReceivedAt).toISOString() 
      : null,
    timestamp: new Date().toISOString(),
  });
});

export default router;
