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
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ promise, reason }, "CRITICAL: Unhandled Promise Rejection detected in process");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "CRITICAL: Uncaught Exception detected in process");
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
  logger.info("API server ready on :5000 — frontend served by nginx on :3000");
});
