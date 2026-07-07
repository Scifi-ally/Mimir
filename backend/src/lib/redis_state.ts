import Redis from "ioredis";
import { logger } from "./logger";
import { defaultOptions } from "./redis";

let redis: Redis | null = null;
let disabled = false;

export function getRedisClient(): Redis | null {
  if (disabled) return null;
  if (redis) return redis;
  const url = process.env["REDIS_URL"] || "redis://localhost:6379";
  try {
    redis = new Redis(url, defaultOptions);
    redis.on("error", (err) => {
      logger.debug({ err }, "Redis state client error");
    });
  } catch (err) {
    logger.warn({ err }, "Failed to initialize Redis state client");
    disabled = true;
    return null;
  }
  return redis;
}

export const stateStore = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async saveMonitoredStock(symbol: string, data: any): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    try {
      if (client.status === "wait") await client.connect();
      await client.hset("upstox:monitored_stocks", symbol, JSON.stringify(data));
      await client.expire("upstox:monitored_stocks", 86400); // 24 hours TTL
    } catch (err) {
      logger.debug({ err, symbol }, "Failed to save monitored stock to Redis");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async loadAllMonitoredStocks(): Promise<Map<string, any>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any>();
    const client = getRedisClient();
    if (!client) return map;
    try {
      if (client.status === "wait") await client.connect();
      const data = await client.hgetall("upstox:monitored_stocks");
      for (const [symbol, json] of Object.entries(data)) {
        map.set(symbol, JSON.parse(json));
      }
    } catch (err) {
      logger.debug({ err }, "Failed to load monitored stocks from Redis");
    }
    return map;
  },

  async clearMonitoredStocks(): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    try {
      if (client.status === "wait") await client.connect();
      await client.del("upstox:monitored_stocks");
    } catch (err) {
      logger.debug({ err }, "Failed to clear monitored stocks from Redis");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async pushTick(symbol: string, tick: any, maxLimit: number): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    try {
      if (client.status === "wait") await client.connect();
      const pipeline = client.pipeline();
      pipeline.lpush(`upstox:ticks:${symbol}`, JSON.stringify(tick));
      pipeline.ltrim(`upstox:ticks:${symbol}`, 0, maxLimit - 1);
      pipeline.expire(`upstox:ticks:${symbol}`, 86400); // 24 hours TTL
      await pipeline.exec();
    } catch (err) {
      logger.debug({ err, symbol }, "Failed to push tick to Redis");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async batchPushTicks(ticksBySymbol: Record<string, any[]>, maxLimit: number): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    try {
      if (client.status === "wait") await client.connect();
      const pipeline = client.pipeline();
      for (const [symbol, ticks] of Object.entries(ticksBySymbol)) {
        if (!ticks.length) continue;
        // Lpush accepts multiple arguments, pushing all ticks at once
        const serializedTicks = ticks.map(t => JSON.stringify(t));
        pipeline.lpush(`upstox:ticks:${symbol}`, ...serializedTicks);
        pipeline.ltrim(`upstox:ticks:${symbol}`, 0, maxLimit - 1);
        pipeline.expire(`upstox:ticks:${symbol}`, 86400); // 24 hours TTL
      }
      await pipeline.exec();
    } catch (err) {
      logger.debug({ err }, "Failed to batch push ticks to Redis");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTicks(symbol: string): Promise<any[]> {
    const client = getRedisClient();
    if (!client) return [];
    try {
      if (client.status === "wait") await client.connect();
      const list = await client.lrange(`upstox:ticks:${symbol}`, 0, -1);
      return list.map((item) => JSON.parse(item)).reverse();
    } catch (err) {
      logger.debug({ err, symbol }, "Failed to get ticks from Redis");
      return [];
    }
  },
  
  async clearTicks(symbol: string): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    try {
      if (client.status === "wait") await client.connect();
      await client.del(`upstox:ticks:${symbol}`);
    } catch (err) {
      logger.debug({ err, symbol }, "Failed to clear ticks from Redis");
    }
  }
};
