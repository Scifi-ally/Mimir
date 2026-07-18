import "../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { initWebSocketServer } from "./ws/websocket_server";
import { startScheduler } from "./scheduler/jobs";
import { initConfigFromDb } from "./config";
import { initAccessTokenFromDb } from "./upstox/auth";
import { logSecurityMode } from "./lib/security";
import { startMarketIntelligence } from "./intelligence/orchestrator";
import { initPaperEngine } from "./trading/paper_engine";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global process-level crash guards to prevent automatic server shutdowns
// eslint-disable-next-line @typescript-eslint/no-explicit-any
process.on("unhandledRejection", (reason: any, promise) => {
  logger.error({ promise, reason: reason instanceof Error ? reason.stack : reason }, "CRITICAL: Unhandled Promise Rejection detected in process");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "CRITICAL: Uncaught Exception detected in process");
  process.exit(1);
});

dotenvConfig({ path: path.resolve(__dirname, "../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../.env") });

const port = Number(process.env["PORT"] ?? 5000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

const server = http.createServer(app);

initWebSocketServer(server);
logSecurityMode();

try {
  await Promise.all([initConfigFromDb(), initAccessTokenFromDb()]);
} catch (err) {
  logger.warn({ err }, "Startup state restore failed; continuing with defaults");
}

if (!process.env["UPSTOXBOT_SECRET_KEY"] && !process.env["UPSTOXBOT_ADMIN_TOKEN"]) {
  logger.warn("Security Warning: UPSTOXBOT_SECRET_KEY is not set. Upstox tokens will be stored in plain text.");
}

startScheduler();
initPaperEngine().catch((err) => {
  logger.error({ err }, "Failed to start Paper Trading engine");
});
startMarketIntelligence().catch((err) => {
  logger.warn({ err }, "Market intelligence startup failed; legacy services continue");
});

server.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening on 0.0.0.0");
  logger.info(`API server ready on :${port} — frontend served by nginx on :3000`);
});

// ARCHITECTURAL FIX (Issue #38): Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn({ signal }, "Shutdown already in progress");
    return;
  }
  
  isShuttingDown = true;
  logger.info({ signal }, "Received shutdown signal - starting graceful shutdown");
  
  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed - no new connections accepted");
  });
  
  try {
    // Stop background services
    logger.info("Stopping scheduler and market intelligence...");
    const { stopScheduler } = await import("./scheduler/jobs");
    const { marketIntelligence } = await import("./intelligence/orchestrator");
    
    if (typeof stopScheduler === 'function') {
      stopScheduler();
    }
    marketIntelligence.stop();
    
    // Wait for in-flight operations to complete (max 30 seconds)
    logger.info("Waiting for in-flight operations to complete...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Close database connections
    const { pool } = await import("../db/src");
    await pool.end();
    
    // Close Redis
    logger.info("Closing Redis connections...");
    const { redisClient } = await import("./lib/redis");
    if (redisClient.status === "ready") {
      await redisClient.quit();
    }
    
    logger.info("Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown");
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
