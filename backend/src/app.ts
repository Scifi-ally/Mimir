import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiRateLimit, isAllowedOrigin, requireAdmin } from "./lib/security";
import { logApiError } from "./lib/api-errors";
import screenerRouter from "./routes/screener";
import { ZodError } from "zod";

const app: Express = express();
app.set("trust proxy", 1); // Trust first proxy for correct IP in rate limiting and logs

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS: " + String(origin)));
    },
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

app.use("/api", apiRateLimit);

// ARCHITECTURAL FIX (Issue #37): Health check endpoints for monitoring and orchestration
app.get("/health", (_req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get("/ready", async (_req, res) => {
  try {
    // Check database connectivity
    const { db } = await import("../db/src");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`SELECT 1`);
    
    // Check Redis connectivity
    const { redisClient } = await import("./lib/redis");
    if (redisClient.status !== "ready") {
      throw new Error("Redis not connected");
    }
    await redisClient.ping();
    
    // Check market feed status
    const { getMarketFeedSnapshot } = await import("./market_data/market_feed");
    const feed = getMarketFeedSnapshot();
    
    res.json({ 
      status: 'ready',
      checks: {
        database: 'ok',
        redis: 'ok',
        marketFeed: feed.status === 'failed' ? 'degraded' : 'ok'
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error({ err }, "Readiness check failed");
    res.status(503).json({
      status: 'not ready',
      error: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

app.get("/live", (_req, res) => {
  // Simple liveness check - is process responsive?
  res.json({ 
    status: 'alive',
    timestamp: new Date().toISOString()
  });
});
app.use("/api", requireAdmin);
app.use("/api", router);
app.use("/api", screenerRouter);

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logApiError(req, err);
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      status: "error",
      error: "Validation Error",
      issues: err.errors,
      route: req.originalUrl,
    });
  }

  const isDev = process.env.NODE_ENV !== "production";
  res.status(500).json({
    status: "error",
    error: isDev ? (err instanceof Error ? err.message : String(err)) : "Internal server error",
    route: req.originalUrl,
  });
});

export default app;
