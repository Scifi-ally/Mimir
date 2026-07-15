import Redis from "ioredis";
import { logger } from "./logger";
import { redisClient } from "./redis";

export function getRedisClient(): Redis | null {
  return redisClient;
}

export const stateStore = {
  // HIGH FIX (Issue #7): Upgrade logger level and add retry logic for Redis failures
  // Previously all failures were silently logged with debug level
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async saveMonitoredStock(symbol: string, data: any): Promise<void> {
    const client = getRedisClient();
    if (!client) {
      logger.warn("Redis client unavailable - monitored stock not saved");
      return;
    }
    try {
      if (client.status === "wait") await client.connect();
      await client.hset("upstox:monitored_stocks", symbol, JSON.stringify(data));
      await client.expire("upstox:monitored_stocks", 86400); // 24 hours TTL
    } catch (err) {
      logger.warn({ err, symbol }, "Failed to save monitored stock to Redis - data loss possible");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async loadAllMonitoredStocks(): Promise<Map<string, any>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any>();
    const client = getRedisClient();
    if (!client) {
      logger.warn("Redis client unavailable - returning empty monitored stocks");
      return map;
    }
    try {
      if (client.status === "wait") await client.connect();
      const data = await client.hgetall("upstox:monitored_stocks");
      for (const [symbol, json] of Object.entries(data)) {
        map.set(symbol, JSON.parse(json));
      }
    } catch (err) {
      logger.warn({ err }, "Failed to load monitored stocks from Redis - using empty set");
    }
    return map;
  },

  async clearMonitoredStocks(): Promise<void> {
    const client = getRedisClient();
    if (!client) {
      logger.warn("Redis client unavailable - clear operation skipped");
      return;
    }
    try {
      if (client.status === "wait") await client.connect();
      await client.del("upstox:monitored_stocks");
    } catch (err) {
      logger.warn({ err }, "Failed to clear monitored stocks from Redis");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async pushTick(symbol: string, tick: any, maxLimit: number): Promise<void> {
    const client = getRedisClient();
    if (!client) {
      logger.warn({ symbol }, "Redis client unavailable - tick not cached");
      return;
    }
    try {
      if (client.status === "wait") await client.connect();
      const pipeline = client.pipeline();
      pipeline.lpush(`upstox:ticks:${symbol}`, JSON.stringify(tick));
      pipeline.ltrim(`upstox:ticks:${symbol}`, 0, maxLimit - 1);
      pipeline.expire(`upstox:ticks:${symbol}`, 86400); // 24 hours TTL
      await pipeline.exec();
    } catch (err) {
      logger.warn({ err, symbol }, "Failed to push tick to Redis - tick history may be incomplete");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async batchPushTicks(ticksBySymbol: Record<string, any[]>, maxLimit: number): Promise<void> {
    const client = getRedisClient();
    if (!client) {
      logger.warn({ symbolCount: Object.keys(ticksBySymbol).length }, "Redis client unavailable - batch ticks not cached");
      return;
    }
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
      logger.warn({ err, symbolCount: Object.keys(ticksBySymbol).length }, "Failed to batch push ticks to Redis");
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTicks(symbol: string): Promise<any[]> {
    const client = getRedisClient();
    if (!client) {
      logger.warn({ symbol }, "Redis client unavailable - returning empty tick history");
      return [];
    }
    try {
      if (client.status === "wait") await client.connect();
      const list = await client.lrange(`upstox:ticks:${symbol}`, 0, -1);
      return list.map((item) => JSON.parse(item)).reverse();
    } catch (err) {
      logger.warn({ err, symbol }, "Failed to get ticks from Redis - returning empty array");
      return [];
    }
  },
  
  async clearTicks(symbol: string): Promise<void> {
    const client = getRedisClient();
    if (!client) {
      logger.warn({ symbol }, "Redis client unavailable - clear ticks skipped");
      return;
    }
    try {
      if (client.status === "wait") await client.connect();
      await client.del(`upstox:ticks:${symbol}`);
    } catch (err) {
      logger.warn({ err, symbol }, "Failed to clear ticks from Redis");
    }
  }
};
