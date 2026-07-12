import { Router, type IRouter } from "express";
import { db } from "../../db/src";
import { sql, desc } from "drizzle-orm";
import { alphaScoreIcHistoryTable } from "../../db/src/schema/alpha_health";
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

router.get("/alpha-score/health", async (req, res) => {
  try {
    const history = await db
      .select()
      .from(alphaScoreIcHistoryTable)
      .orderBy(desc(alphaScoreIcHistoryTable.computedAt))
      .limit(52); // past year if weekly

    res.json({
      status: "ok",
      history
    });
  } catch (err) {
    (req.log || logger).error({ err }, "Failed to fetch Alpha Score IC history");
    res.status(500).json({ status: "error", error: "Internal server error" });
  }
});

export default router;
