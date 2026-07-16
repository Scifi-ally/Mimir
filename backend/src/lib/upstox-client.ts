/**
 * Optimized Upstox API client with:
 * - Request batching for LTP queries
 * - Retry logic with exponential backoff
 * - Response caching
 * - Request deduplication
 */
import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";
import { logger } from "./logger";
import { Cache, RequestDeduplicator } from "./cache";
import {
  recordHistoricalApiCall,
  recordHistoricalCacheHit,
  recordLtpApiCall,
  recordLtpCacheHit,
} from "./data_telemetry";
import { isMarketOpen } from "../market_data/market_state";

const BASE_URL = "https://api.upstox.com/v2";
const DEFAULT_TIMEOUT = 15000;
const BATCH_SIZE = 50; // Max instruments per request
const LOG_UPSTOX_PAYLOADS =
  (process.env["LOG_UPSTOX_PAYLOADS"] ?? "false").toLowerCase() === "true";

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeCandlesNewestFirst(candles: any[][]): any[][] {
  const parsed = candles
    .map((row) => {
      const ts = typeof row?.[0] === "string" ? row[0] : null;
      if (!ts) return null;
      const ms = Date.parse(ts);
      if (!Number.isFinite(ms)) return null;
      return { row, ts, ms };
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((x): x is { row: any[]; ts: string; ms: number } => Boolean(x));

  // Sanity check: filter out dirty bars (negative prices) and fix inverted high/low
  const sanitized = parsed.filter(item => {
    const row = item.row;
    if (row.length < 5) return false;
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);

    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) return false;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return false;

    // Fix inverted high/low — some feeds swap them during illiquid ticks
    if (h < l) {
      const maxVal = Math.max(h, l);
      const minVal = Math.min(h, l);
      row[2] = maxVal;
      row[3] = minVal;
    }
    return true;
  });

  sanitized.sort((a, b) => b.ms - a.ms);

  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deduped: any[][] = [];
  for (const item of sanitized) {
    if (seen.has(item.ts)) continue;
    seen.add(item.ts);
    deduped.push(item.row);
  }
  return deduped;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
};

/**
 * Global rate limiter for Upstox API requests.
 * 
 * DESIGN NOTE: Priority requests are always dequeued before non-priority ones.
 * This means sustained high-priority traffic can starve non-priority requests
 * until they time out (maxWaitMs). This is an accepted tradeoff — real-time
 * tick data and live trade execution take precedence over background scans.
 * Non-priority timeouts are logged at warn level for observability.
 */
class GlobalRateLimiter {
  private queue: { resolve: () => void; reject: (err: Error) => void; enqueueTime: number; priority: boolean }[] = [];
  private processing = false;
  private reqsInLastSecond = 0;
  private intervalStarted = Date.now();
  private maxWaitMs = 30000;

  async wait(priority: boolean = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, enqueueTime: Date.now(), priority };
      if (priority) {
        const idx = this.queue.findIndex(i => !i.priority);
        if (idx === -1) this.queue.push(item);
        else this.queue.splice(idx, 0, item);
      } else {
        this.queue.push(item);
      }
      this.process();
    });
  }

  private process() {
    if (this.processing) return;
    this.processing = true;

    const tick = () => {
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }
      
      const now = Date.now();
      
      // Clear expired items
      while (this.queue.length > 0 && now - this.queue[0]!.enqueueTime > this.maxWaitMs) {
        const item = this.queue.shift()!;
        const waitMs = now - item.enqueueTime;
        logger.warn({ waitMs, queueDepth: this.queue.length, wasPriority: item.priority }, 
          'RateLimiter: request timed out waiting in queue');
        item.reject(new Error(`RateLimiter timeout: Waited in queue for over ${this.maxWaitMs}ms`));
      }
      
      if (this.queue.length === 0) {
        this.processing = false;
        return;
      }

      if (now - this.intervalStarted >= 1000) {
        this.reqsInLastSecond = 0;
        this.intervalStarted = now;
      }
      
      // Upstox rate limit: 10 req/sec per API version (V2 and V3 counted separately).
      // This limiter tracks a COMBINED count across all endpoints — it does NOT
      // enforce per-version limits. During market hours we use a conservative 8 req/s
      // combined limit. Off-hours, we allow 14 req/s since the load-balancer
      // (v3RoundRobin in fetchHistoricalCandles) distributes roughly evenly across
      // V2 and V3. TODO: Track per-version request counts for true per-endpoint limiting.
      const safeLimit = isMarketOpen() ? 8 : 14;
      if (this.reqsInLastSecond < safeLimit) {
        this.reqsInLastSecond++;
        const item = this.queue.shift();
        item?.resolve();
        setImmediate(tick);
      } else {
        const delay = 1000 - (now - this.intervalStarted);
        setTimeout(tick, delay);
      }
    };
    
    tick();
  }
}

export const apiRateLimiter = new GlobalRateLimiter();

/**
 * Execute with exponential backoff retry
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  priority: boolean = false,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      await apiRateLimiter.wait(priority);
      return await fn();
    } catch (err) {
      lastError = err as Error;

      if (attempt === config.maxRetries) break;

      const axiosErr = err as AxiosError;
      if (
        axiosErr.response?.status &&
        axiosErr.response.status >= 400 &&
        axiosErr.response.status < 500 &&
        axiosErr.response.status !== 429
      ) {
        const status = axiosErr.response.status;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errData = axiosErr.response.data as any;
        const isAuthErr =
          status === 401 ||
          status === 403 ||
          errData?.errors?.[0]?.errorCode === "UDAPI100050" ||
          (typeof errData?.errors?.[0]?.message === "string" && errData.errors[0].message.toLowerCase().includes("invalid token"));

        if (isAuthErr) {
          try {
            const { invalidateAccessToken } = await import("../upstox/auth");
            await invalidateAccessToken(
              `Upstox API Authentication Failure: ${status} - ${errData?.errors?.[0]?.message || "Unauthorized"}`
            );
          } catch (importErr) {
            logger.warn({ importErr }, "Failed to dynamically import invalidateAccessToken");
          }
        }
        throw err;
      }

      // Use Retry-After header if present (429 only)
      let delayMs: number;
      if (axiosErr.response?.status === 429) {
        const retryAfter = axiosErr.response.headers?.["retry-after"];
        if (retryAfter) {
          const parsed = parseInt(String(retryAfter), 10);
          if (!isNaN(parsed) && parsed > 0) {
            delayMs = Math.min(parsed * 1000, config.maxDelayMs);
          } else {
            delayMs = Math.min(
              config.baseDelayMs * Math.pow(2, attempt),
              config.maxDelayMs,
            );
          }
        } else {
          delayMs = Math.min(
            config.baseDelayMs * Math.pow(2, attempt),
            config.maxDelayMs,
          );
        }
      } else {
        delayMs = Math.min(
          config.baseDelayMs * Math.pow(2, attempt),
          config.maxDelayMs,
        );
      }

      const is429 = axiosErr.response?.status === 429;
      const logPayload = {
        operation,
        attempt: attempt + 1,
        delayMs,
        status: axiosErr.response?.status,
        error: lastError.message,
      };
      if (is429) {
        logger.warn(logPayload, "Upstox API Rate Limit hit (429)! Retrying after backoff.");
      } else {
        logger.info(logPayload, "Retrying request due to error");
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw (
    lastError ||
    new Error(`Failed after ${config.maxRetries} retries: ${operation}`)
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QuoteData = any;

export interface UpstoxApiClient {
  fetchQuotesForInstruments(
    keys: string[],
    token: string,
    priority?: boolean,
  ): Promise<Record<string, QuoteData>>;
  fetchLTPForInstruments(
    keys: string[],
    token: string,
    priority?: boolean,
  ): Promise<Record<string, number>>;
  fetchHistoricalCandles(
    instrumentKey: string,
    interval: "1minute" | "5minute" | "15minute" | "day" | "60minute" | "240minute" | "week",
    toDate: string,
    fromDate: string,
    token: string,
  ): Promise<unknown[][]>;
}

function normalizeInstrumentKey(value: string): string {
  return value.trim().toUpperCase().replace(":", "|");
}

function mapV2IntervalToV3(
  interval: "1minute" | "5minute" | "15minute" | "day" | "60minute" | "240minute" | "week",
): { unit: "minutes" | "hours" | "days" | "weeks"; size: number } {
  switch (interval) {
    case "1minute":
      return { unit: "minutes", size: 1 };
    case "5minute":
      return { unit: "minutes", size: 5 };
    case "15minute":
      return { unit: "minutes", size: 15 };
    case "60minute":
      return { unit: "hours", size: 1 };
    case "240minute":
      return { unit: "hours", size: 4 };
    case "week":
      return { unit: "weeks", size: 1 };
    case "day":
    default:
      return { unit: "days", size: 1 };
  }
}

/**
 * Create an optimized Upstox API client
 */
export function createUpstoxClient(options?: {
  cacheTimeMs?: number;
}): UpstoxApiClient {
  const cacheTimeMs = options?.cacheTimeMs ?? 5 * 60 * 1000; // 5 minutes default
  const ltpCache = new Cache<string, number>();
  const candleCache = new Cache<string, unknown[][]>();
  const ltpDeduplicator = new RequestDeduplicator<
    string,
    Record<string, number>
  >();
  const candleDeduplicator = new RequestDeduplicator<string, unknown[][]>();
  const quoteCache = new Cache<string, Record<string, QuoteData>>();
  const quoteDeduplicator = new RequestDeduplicator<
    string,
    Record<string, QuoteData>
  >();

  async function fetchQuotesForInstruments(
    instrumentKeys: string[],
    token: string,
    priority: boolean = false,
  ): Promise<Record<string, QuoteData>> {
    if (!instrumentKeys.length) return {};
    const normalizedKeys = instrumentKeys.map(normalizeInstrumentKey);
    const cacheKey = normalizedKeys.slice().sort().join(",");
    
    const cached = quoteCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    return quoteDeduplicator.execute(cacheKey, async () => {
      const result: Record<string, QuoteData> = {};
      for (let i = 0; i < normalizedKeys.length; i += 500) {
        const batch = normalizedKeys.slice(i, i + 500);
        try {
          const data = await withRetry(
            async () => {
              const url = `${BASE_URL}/market-quote/quotes`;
              const resp = await axios.get(url, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: "application/json",
                },
                params: {
                  instrument_key: batch.join(","),
                },
                timeout: DEFAULT_TIMEOUT,
              });
              return resp.data;
            },
            "fetchQuotesForInstruments",
            DEFAULT_RETRY_CONFIG,
            priority
          );

          if (data && data.data) {
            const normalizedBatch = new Set(batch.map((k) => normalizeInstrumentKey(k)));
            for (const [key, quote] of Object.entries(data.data)) {
              const payload = quote as { instrument_token?: string };
              const tokenKey = payload.instrument_token
                ? normalizeInstrumentKey(payload.instrument_token)
                : "";
              const mapNorm = normalizeInstrumentKey(key);
              const canonical =
                normalizedBatch.has(tokenKey)
                  ? tokenKey
                  : normalizedBatch.has(mapNorm)
                    ? mapNorm
                    : tokenKey || mapNorm;
              if (canonical) {
                result[canonical] = quote as QuoteData;
              }
            }
          }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.error({ err: err.message, batchLength: batch.length }, "Failed to fetch quotes for batch");
      }
    }
    
    quoteCache.set(cacheKey, result, cacheTimeMs);
    return result;
    });
  }

  /**
   * Fetch LTP for multiple instruments, batched and cached
   */
  async function fetchLTPForInstruments(
    keys: string[],
    token: string,
    priority: boolean = false,
  ): Promise<Record<string, number>> {
    if (keys.length === 0) return {};

    // Deduplicate by joining keys
    const keySet = new Set(keys);
    const uniqueKeys = Array.from(keySet);
    const cacheKey = JSON.stringify(uniqueKeys);

    return ltpDeduplicator.execute(cacheKey, async () => {
      const result: Record<string, number> = {};

      // Check cache first
      const uncachedKeys: string[] = [];
      for (const key of uniqueKeys) {
        const cached = ltpCache.get(key);
        if (cached !== undefined) {
          result[key] = cached;
          recordLtpCacheHit();
        } else {
          uncachedKeys.push(key);
        }
      }

      if (uncachedKeys.length === 0) return result;

      // Fetch uncached keys in batches
      for (let i = 0; i < uncachedKeys.length; i += BATCH_SIZE) {
        const batch = uncachedKeys.slice(i, i + BATCH_SIZE);

        const data = await withRetry(
          async () => {
            const url = `${BASE_URL}/market-quote/ltp`;
            const resp = await axios.get(url, {
              params: { instrument_key: batch.join(",") },
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
              },
              timeout: DEFAULT_TIMEOUT,
            });
            recordLtpApiCall();
            const payload = resp.data?.data ?? {};
            if (LOG_UPSTOX_PAYLOADS) {
              logger.info(
                {
                  api: "upstox_ltp",
                  requested: batch.length,
                  returned: Object.keys(payload).length,
                  sample: Object.entries(payload).slice(0, 3),
                },
                "Received Upstox LTP payload",
              );
            }
            return payload;
          },
          `LTP fetch batch (${batch.length} instruments)`,
          { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000 },
          priority
        );

        // Parse and cache results (handle both map-key and instrument_token variants)
        const normalizedBatch = new Set(batch.map((k) => normalizeInstrumentKey(k)));
        for (const [mapKey, priceData] of Object.entries(data)) {
          const payload = priceData as {
            last_price?: number;
            instrument_token?: string;
          };
          const price = payload.last_price;
          if (price == null) continue;
          const tokenKey = payload.instrument_token
            ? normalizeInstrumentKey(payload.instrument_token)
            : "";
          const mapNorm = normalizeInstrumentKey(mapKey);
          const canonical =
            normalizedBatch.has(tokenKey)
              ? tokenKey
              : normalizedBatch.has(mapNorm)
                ? mapNorm
                : tokenKey || mapNorm;
          if (!canonical) continue;
          result[canonical] = price;
          ltpCache.set(canonical, price, cacheTimeMs);
        }
      }

      return result;
    });
  }

  /**
   * Fetch historical candles with caching
   */
  let v3RoundRobin = false;

  async function fetchHistoricalCandles(
    instrumentKey: string,
    interval: "1minute" | "5minute" | "15minute" | "day" | "60minute" | "240minute" | "week",
    toDate: string,
    fromDate: string,
    token: string,
    priority: boolean = false,
  ): Promise<unknown[][]> {
    const cacheKey = `${instrumentKey}|${interval}|${toDate}|${fromDate}`;

    // Check memory cache
    const cached = candleCache.get(cacheKey);
    if (cached) {
      recordHistoricalCacheHit(cached.length);
      return cached;
    }

    const cacheDir = path.resolve(process.cwd(), ".cache/market_data");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const safeCacheKey = cacheKey.replace(/[^a-zA-Z0-9]/g, "_");
    const diskCachePath = path.join(cacheDir, `${safeCacheKey}.json`);

    // Check disk cache (with TTL)
    if (fs.existsSync(diskCachePath)) {
      try {
        const raw = fs.readFileSync(diskCachePath, "utf-8");
        const envelope = JSON.parse(raw);
        // Support both legacy arrays and new { data, ts } envelopes
        const diskData = Array.isArray(envelope) ? envelope : envelope.data;
        const cachedAt = Array.isArray(envelope) ? 0 : (envelope.ts as number) || 0;
        if (Array.isArray(diskData) && diskData.length > 0 && (Date.now() - cachedAt) < cacheTimeMs) {
          candleCache.set(cacheKey, diskData, cacheTimeMs);
          recordHistoricalCacheHit(diskData.length);
          return diskData;
        }
      } catch (err) {
        logger.warn({ err }, "Failed to read historical data from disk cache");
      }
    }

    return candleDeduplicator.execute(cacheKey, async () => {
      const data = await withRetry(
        async () => {
          const fetchV3 = async () => {
            const mapped = mapV2IntervalToV3(interval);
            const v3Url = `${BASE_URL.replace("/v2", "/v3")}/historical-candle/${encodeURIComponent(instrumentKey)}/${mapped.unit}/${mapped.size}/${toDate}/${fromDate}`;
            const v3Resp = await axios.get(v3Url, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              timeout: DEFAULT_TIMEOUT,
            });
            return v3Resp.data?.data?.candles ?? [];
          };

          const fetchV2 = async () => {
            const v2Url = `${BASE_URL}/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${toDate}/${fromDate}`;
            const v2Resp = await axios.get(v2Url, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
              },
              timeout: DEFAULT_TIMEOUT,
            });
            return v2Resp.data?.data?.candles ?? [];
          };

          const isV3OnlyInterval =
            interval === "5minute" ||
            interval === "15minute" ||
            interval === "60minute" ||
            interval === "240minute";

          let preferV3 = isV3OnlyInterval || interval === "week";
          
          if (!preferV3 && !isMarketOpen()) {
            v3RoundRobin = !v3RoundRobin;
            preferV3 = v3RoundRobin;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let candles: any[][] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let lastError: any = null;
          try {
            candles = preferV3 ? await fetchV3() : await fetchV2();
          } catch (primaryErr) {
            lastError = primaryErr;
            const status = (primaryErr as AxiosError).response?.status;
            const data = (primaryErr as AxiosError).response?.data;
            logger.warn(
              { err: primaryErr, status, data, instrumentKey, interval, fromDate, toDate, preferV3 },
              "Primary candle endpoint failed; trying fallback endpoint if compatible",
            );
          }

          // Only try the fallback endpoint if the primary endpoint actually failed and fallback supports this interval.
          if (candles.length === 0 && lastError && !isV3OnlyInterval) {
            try {
              await apiRateLimiter.wait(priority); 
              candles = preferV3 ? await fetchV2() : await fetchV3();
              lastError = null; // Clear primary error if fallback succeeded
            } catch (fallbackErr) {
              lastError = fallbackErr;
              const status = (fallbackErr as AxiosError).response?.status;
              const data = (fallbackErr as AxiosError).response?.data;
              logger.warn(
                { err: fallbackErr, status, data, instrumentKey, interval, fromDate, toDate },
                "Fallback candle endpoint failed",
              );
            }
          }

          if (candles.length === 0 && lastError) {
            throw lastError;
          }

          recordHistoricalApiCall(candles.length);
          
          // Always log if candles are empty or very few to help diagnose issues
          if (candles.length < 10) {
            logger.warn(
              {
                api: "upstox_historical_candles",
                instrumentKey,
                interval,
                fromDate,
                toDate,
                count: candles.length,
              },
              "WARNING: Insufficient candle data received from Upstox",
            );
          } else if (LOG_UPSTOX_PAYLOADS) {
            logger.info(
              {
                api: "upstox_historical_candles",
                instrumentKey,
                interval,
                fromDate,
                toDate,
                count: candles.length,
                sample: candles.slice(0, 2),
              },
              "Received Upstox historical candle payload",
            );
          }
          return normalizeCandlesNewestFirst(candles);
        },
        `Candles fetch ${instrumentKey} ${interval}`,
        // Keep retries bounded to avoid freezing full scan cycles.
        { maxRetries: 2, baseDelayMs: 300, maxDelayMs: 2000 },
        priority
      );

      // Cache and return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleCache.set(cacheKey, data as any[][], cacheTimeMs);
      
      try {
        fs.writeFileSync(diskCachePath, JSON.stringify({ data, ts: Date.now() }));
      } catch (err) {
        logger.warn({ err }, "Failed to write historical data to disk cache");
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return data as any[][];
    });
  }

    return {
      fetchQuotesForInstruments,
      fetchLTPForInstruments,
      fetchHistoricalCandles,
    };
}
