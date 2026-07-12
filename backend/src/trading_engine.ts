import "../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import { logger } from "./lib/logger";
import { startScheduler } from "./scheduler/jobs";
import { initConfigFromDb } from "./config";
import { initAccessTokenFromDb } from "./upstox/auth";
import { startMarketIntelligence } from "./intelligence/orchestrator";
import { initPositionTracker } from "./trading/position_tracker";
import { createRedisClient } from "./lib/redis";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global process-level crash guards
process.on("unhandledRejection", (reason, promise) => {
  logger.fatal({ promise, reason }, "TRADING ENGINE CRITICAL: Unhandled Promise Rejection detected");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "TRADING ENGINE CRITICAL: Uncaught Exception detected");
  process.exit(1);
});

dotenvConfig({ path: path.resolve(__dirname, "../.env.local"), override: true });
dotenvConfig({ path: path.resolve(__dirname, "../.env") });

const redisPub = createRedisClient("trading_engine_pub");

redisPub.on("error", (err) => {
  logger.debug({ err }, "Trading Engine Redis publisher error");
});

// Override the broadcast function in the WebSocket server module
// so that all events are published to Redis channel instead of local memory sockets
import { setBroadcastFn } from "./ws/websocket_server";
setBroadcastFn((event: unknown, topic: string = "suggestions") => {
  redisPub.publish("trading:events", JSON.stringify({ event, topic })).catch((err) => {
    logger.debug({ err }, "Trading Engine failed to publish event to Redis");
  });
});

async function main() {
  try {
    await redisPub.connect();
    logger.info("Trading Engine connected to Redis publisher");
  } catch (err) {
    logger.warn({ err }, "Redis state publisher is offline. Process bridging disabled.");
  }

  try {
    await initConfigFromDb();
    await initAccessTokenFromDb();
  } catch (err) {
    logger.warn({ err }, "Trading Engine: Startup state restore failed; continuing with defaults");
  }

  startScheduler();

  startMarketIntelligence().catch((err) => {
    logger.warn({ err }, "Market intelligence startup failed; legacy services continue");
  });

  initPositionTracker().catch((err) => {
    logger.error({ err }, "Trading Engine: Failed to initialize position tracker");
  });

  import("./trading/paper_engine").then(({ initPaperEngine }) => {
    initPaperEngine().catch((err) => {
      logger.error({ err }, "Trading Engine: Failed to initialize paper engine");
    });
  });

  logger.info("Trading Engine process started successfully.");
}

void main();
