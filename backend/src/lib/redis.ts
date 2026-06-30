// Resolves Finding 1B: Multiple unmanaged ioredis connections
import { Redis, type RedisOptions } from "ioredis";
import { logger } from "./logger";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const defaultOptions: RedisOptions = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 1) return null;
    const delay = Math.min(times * 100, 500);
    logger.warn({ attempt: times, delay }, "Redis connection retrying...");
    return delay;
  },
  reconnectOnError(err) {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
};

// Singleton shared client for normal cache/storage operations
export const redisClient = new Redis(redisUrl, defaultOptions);

redisClient.on("error", (err) => {
  logger.error({ err }, "Shared Redis client error");
});

redisClient.on("connect", () => {
  logger.info("Shared Redis client connected");
});

// Helper to create specialized clients (e.g. pub/sub subscriber which cannot issue normal commands)
export function createRedisClient(name: string): Redis {
  const client = new Redis(redisUrl, defaultOptions);
  client.on("error", (err) => {
    logger.error({ err, client: name }, `Redis client (${name}) error`);
  });
  client.on("connect", () => {
    logger.info({ client: name }, `Redis client (${name}) connected`);
  });
  return client;
}
