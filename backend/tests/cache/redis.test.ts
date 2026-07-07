import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";

describe("Redis Cache Integrity", () => {
  let redis: Redis;
  let pub: Redis;
  let sub: Redis;

  beforeAll(() => {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    redis = new Redis(url);
    pub = new Redis(url);
    sub = new Redis(url);
  });

  afterAll(async () => {
    redis.disconnect();
    pub.disconnect();
    sub.disconnect();
  });

  it("handles SET/GET/DEL for primitive types and JSON", async () => {
    // String
    await redis.set("mimir:test:string", "value1");
    expect(await redis.get("mimir:test:string")).toBe("value1");
    await redis.del("mimir:test:string");
    expect(await redis.get("mimir:test:string")).toBeNull();

    // JSON
    const obj = { foo: "bar", num: 42 };
    await redis.set("mimir:test:json", JSON.stringify(obj));
    const raw = await redis.get("mimir:test:json");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual(obj);
    await redis.del("mimir:test:json");
  });

  it("enforces TTL strictly", async () => {
    await redis.set("mimir:test:ttl", "temp", "EX", 1);
    const immediate = await redis.get("mimir:test:ttl");
    expect(immediate).toBe("temp");

    // Wait 1500ms
    await new Promise(r => setTimeout(r, 1500));
    const expired = await redis.get("mimir:test:ttl");
    expect(expired).toBeNull();
  });

  it("pub/sub delivers messages within 500ms", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let received: any = null;
    let receivedChannel = "";

    sub.subscribe("market:tick", (err) => {
      if (err) throw err;
    });

    sub.on("message", (channel, message) => {
      receivedChannel = channel;
      received = JSON.parse(message);
    });

    // small delay to ensure subscription is active
    await new Promise(r => setTimeout(r, 200));

    const payload = { symbol: "TEST", ltp: 100.5, timestamp: Date.now() };
    await pub.publish("market:tick", JSON.stringify(payload));

    // wait up to 500ms
    let waited = 0;
    while (!received && waited < 500) {
      await new Promise(r => setTimeout(r, 50));
      waited += 50;
    }

    expect(receivedChannel).toBe("market:tick");
    expect(received).toEqual(payload);
  });

  it("maintains key prefix isolation (BullMQ vs Mimir)", async () => {
    await redis.set("mimir:test:iso", "val");
    
    // Check there are no collisions
    const bullKeys = await redis.keys("bull:*");
    for (const key of bullKeys) {
      expect(key).not.toContain("mimir:");
    }

    const mimirKeys = await redis.keys("mimir:*");
    for (const key of mimirKeys) {
      expect(key).not.toContain("bull:");
    }

    await redis.del("mimir:test:iso");
  });
});
