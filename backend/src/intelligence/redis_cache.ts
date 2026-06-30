import Redis from "ioredis";
import { logger } from "../lib/logger";
import { defaultOptions } from "../lib/redis";

let redis: Redis | null = null;
let disabled = false;

function getRedis(): Redis | null {
  if (disabled) return null;
  if (redis) return redis;
  const url = process.env["REDIS_URL"];
  if (!url) {
    disabled = true;
    return null;
  }
  redis = new Redis(url, defaultOptions);
  redis.on("error", (err) => {
    logger.debug({ err }, "Intelligence Redis cache unavailable");
  });
  return redis;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function cacheJson(key: string, value: any, ttlSeconds: number): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    if (client.status === "wait") await client.connect();
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    logger.debug({ err, key }, "Failed to write intelligence cache");
  }
}

export async function readJson<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    if (client.status === "wait") await client.connect();
    const value = await client.get(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch (err) {
    logger.debug({ err, key }, "Failed to read intelligence cache");
    return null;
  }
}
