import "../load-env.cjs";
import { config as dotenvConfig } from "dotenv";
import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { initWebSocketServer, broadcast } from "./ws/websocket_server";
import { initConfigFromDb } from "./config";
import { initAccessTokenFromDb } from "./upstox/auth";
import { logSecurityMode } from "./lib/security";
import Redis from "ioredis";
import { defaultOptions } from "./lib/redis";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global process-level crash guards to prevent automatic server shutdowns
process.on("unhandledRejection", (reason, promise) => {
  logger.fatal({ promise, reason }, "API SERVER CRITICAL: Unhandled Promise Rejection detected");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "API SERVER CRITICAL: Uncaught Exception detected");
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
  await initConfigFromDb();
  await initAccessTokenFromDb();
} catch (err) {
  logger.warn({ err }, "API Server: Startup state restore failed; continuing with defaults");
}

// Setup Redis subscriber client for process bridging
const redisUrl = process.env["REDIS_URL"] || "redis://localhost:6379";
const redisSub = new Redis(redisUrl, defaultOptions);

redisSub.on("error", (err) => {
  logger.debug({ err }, "API Server Redis subscriber error");
});

async function startRedisSubscriber() {
  try {
    await redisSub.connect();
    await redisSub.subscribe("trading:events");
    logger.info("API Server successfully subscribed to Redis channel 'trading:events'");

    redisSub.on("message", (channel, message) => {
      if (channel === "trading:events") {
        try {
          const { event, topic } = JSON.parse(message);
          
          // Intercept state changes to sync decoupled processes
          if (event && event.type === "marketRegimeChanged") {
            import("./market_data/market_state").then(({ updateMarketState }) => {
              updateMarketState({ 
                regime: event.data.regime,
                suggestionsPaused: event.data.suggestionsPaused,
                pauseReason: event.data.pauseReason
              });
            }).catch((err) => {
              logger.error({ err }, "Failed to dynamically import and update market state");
            });
          }

          broadcast(event, topic);
        } catch (err) {
          logger.error({ err }, "API Server failed to parse/broadcast event");
        }
      }
    });
  } catch (err) {
    logger.warn({ err }, "Redis state messaging bridge is offline. Real-time updates disabled.");
  }
}

void startRedisSubscriber();

server.listen(port, "127.0.0.1", () => {
  logger.info({ port }, "API Server listening on 127.0.0.1");
});

let lastCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastCheck - 1000;
  if (lag > 50) {
    logger.warn({ lagMs: lag }, "API Server Event Loop Lag Detected");
  }
  lastCheck = now;
}, 1000).unref();
