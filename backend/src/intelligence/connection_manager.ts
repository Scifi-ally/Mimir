import { WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs";
import protobuf from "protobufjs";
import axios from "axios";
import { logger } from "../lib/logger";
import { getAccessToken } from "../upstox/auth";
import { intelligenceBus } from "./event_bus";
import { createUpstoxClient } from "../lib/upstox-client";
import type { ConnectionStatusEvent } from "./types";

const UPSTOX_AUTHORIZE_URL = "https://api.upstox.com/v3/feed/market-data-feed/authorize";

const FALLBACK_POLL_INTERVAL_MS = 5000;

export class UpstoxConnectionManager {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickReceivedAt = 0;
  private subscribedKeys: Set<string> = new Set();
  private symbolToKeyMap: Map<string, string> = new Map();
  private keyToSymbolMap: Map<string, string> = new Map();
  
  private reconnectAttempts = 0;
  private consecutiveFailures = 0;
  private circuitBreakerCooldownUntil = 0;
  private readonly circuitBreakerThreshold = 5;
  private readonly circuitBreakerCooldownMs = 300000; // 5 minutes

  private protobufRoot: protobuf.Root | null = null;
  private FeedResponse: protobuf.Type | null = null;
  
  private upstoxClient = createUpstoxClient({ cacheTimeMs: 1000 });

  constructor() {}

  async loadProtobufSchema(): Promise<void> {
    if (this.protobufRoot && this.FeedResponse) return;
    try {
      const dirname = globalThis.__dirname || __dirname;
      const possiblePaths = [
        path.resolve(dirname, "MarketDataFeed.proto"),
        path.resolve(dirname, "src/intelligence/MarketDataFeed.proto"),
        path.resolve(process.cwd(), "src/intelligence/MarketDataFeed.proto"),
        path.resolve(process.cwd(), "backend/src/intelligence/MarketDataFeed.proto")
      ];
      let protoPath: string | null = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          protoPath = p;
          break;
        }
      }
      if (!protoPath) {
        throw new Error(`Could not find MarketDataFeed.proto in any of: ${possiblePaths.join(", ")}`);
      }
      this.protobufRoot = await protobuf.load(protoPath);
      this.FeedResponse = this.protobufRoot.lookupType("com.upstox.marketdatafeeder.rpc.proto.FeedResponse");
      logger.info("Protobuf schema loaded in Connection Manager");
    } catch (err) {
      logger.error({ err }, "Failed to load Protobuf schema in Connection Manager");
      throw err;
    }
  }

  resetCircuitBreakerAndConnect(): void {
    logger.info("Resetting Upstox WS circuit breaker and forcing reconnect after authentication update.");
    this.circuitBreakerCooldownUntil = 0;
    this.consecutiveFailures = 0;
    this.reconnectAttempts = 0;
    this.disconnect();
    void this.connect();
  }

  async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    if (Date.now() < this.circuitBreakerCooldownUntil) {
      const waitTimeSec = Math.ceil((this.circuitBreakerCooldownUntil - Date.now()) / 1000);
      logger.warn({ waitTimeSec }, "Upstox WS reconnect circuit breaker active. Aborting connect attempt.");
      this.publishStatus("failed", "upstox_ws", `Circuit breaker active. Cooldown for another ${waitTimeSec}s`);
      this.scheduleReconnect();
      return;
    }

    this.isConnecting = true;
    this.publishStatus("connecting", "upstox_ws");

    try {
      const token = getAccessToken("data");
      if (!token) {
        logger.warn("No Upstox access token available for Connection Manager");
        this.isConnecting = false;
        this.publishStatus("failed", "upstox_ws", "No access token");
        this.scheduleReconnect();
        return;
      }

      await this.loadProtobufSchema();

      const authResponse = await axios.get(UPSTOX_AUTHORIZE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        timeout: 10000,
      });

      const wsUrl = authResponse.data?.data?.authorized_redirect_uri || authResponse.data?.data?.authorizedRedirectUri;
      if (!wsUrl) {
        throw new Error("No authorized redirect URI returned in Upstox response");
      }

      logger.info("Connecting to Upstox Market Data Feed WebSocket...");
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", async () => {
        logger.info("Upstox WebSocket connected in Connection Manager");
        this.isConnecting = false;
        this.consecutiveFailures = 0;
        this.reconnectAttempts = 0;
        this.circuitBreakerCooldownUntil = 0;
        this.publishStatus("connected", "upstox_ws");
        
        try {
          const { syncMonitoredSubscriptions } = await import("../market_data/monitored_symbols");
          await syncMonitoredSubscriptions();
        } catch (err) {
          logger.error({ err }, "Failed to sync monitored subscriptions on WS open, using cached subscriptions");
          this.subscribeToAll();
        }
        this.startFallbackPolling();
      });

      this.ws.on("message", (raw) => {
        this.handleWsMessage(raw);
      });

      this.ws.on("close", (code, reason) => {
        const reasonStr = reason ? reason.toString() : "unknown close";
        logger.warn({ code, reason: reasonStr }, "Upstox WebSocket disconnected");
        this.isConnecting = false;
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
          this.circuitBreakerCooldownUntil = Date.now() + this.circuitBreakerCooldownMs;
          logger.error({ cooldownMs: this.circuitBreakerCooldownMs }, "Upstox WS connection failures exceeded threshold. Circuit breaker tripped.");
        }
        this.publishStatus("disconnected", "upstox_ws", reasonStr);
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        logger.error({ err }, "Upstox WebSocket error in Connection Manager");
        this.isConnecting = false;
        this.publishStatus("failed", "upstox_ws", err.message);
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error({ err }, "Failed to connect Upstox WebSocket in Connection Manager");
      this.isConnecting = false;
      this.consecutiveFailures++;

      // Check if it's an authorization failure (401/403 or invalid token msg)
      const isAuthError =
        err?.response?.status === 401 ||
        err?.response?.status === 403 ||
        err?.response?.data?.errors?.[0]?.errorCode === "UDAPI100050" ||
        err?.response?.data?.errors?.[0]?.message?.toLowerCase().includes("invalid token");

      if (isAuthError) {
        logger.warn({ status: err?.response?.status, error: err?.response?.data }, "Invalid Upstox token detected in connection manager; invalidating token");
        try {
          const { invalidateAccessToken } = await import("../upstox/auth");
          await invalidateAccessToken(`WS Auth failed: ${err.message}`);
        } catch (importErr) {
          logger.warn({ importErr }, "Failed to dynamically import invalidateAccessToken in connection manager");
        }
      }

      if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
        this.circuitBreakerCooldownUntil = Date.now() + this.circuitBreakerCooldownMs;
        logger.error({ cooldownMs: this.circuitBreakerCooldownMs }, "Upstox WS connection failures exceeded threshold. Circuit breaker tripped.");
      }

      this.publishStatus("failed", "upstox_ws", err.message || String(err));
      this.scheduleReconnect();
    }
  }

  private publishStatus(status: ConnectionStatusEvent["status"], source: ConnectionStatusEvent["source"], reason?: string) {
    intelligenceBus.publish("connectionStatus", {
      status,
      source,
      timestamp: Date.now(),
      reason,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleWsMessage(raw: any) {
    try {
      if (!this.FeedResponse) return;

      let buffer: Uint8Array;
      if (Buffer.isBuffer(raw)) {
        buffer = new Uint8Array(raw);
      } else if (raw instanceof ArrayBuffer) {
        buffer = new Uint8Array(raw);
      } else if (Array.isArray(raw)) {
        buffer = new Uint8Array(Buffer.concat(raw));
      } else {
        logger.warn({ raw: typeof raw === "string" ? raw : String(raw) }, "Received string or unsupported message from Upstox WS");
        return;
      }

      const decoded = this.FeedResponse.decode(buffer);
      const message = this.FeedResponse.toObject(decoded, {
        longs: Number,
        enums: String,
        oneofs: true,
      });

      if (!message || !message.feeds) return;

        this.lastTickReceivedAt = Date.now();
        if (Object.keys(message.feeds).length === 0) {
          logger.warn(`Empty feeds! Message type: ${message.type}`);
        }

      for (const [key, feed] of Object.entries(message.feeds)) {
        if (!feed) continue;

        const normalizedKey = key.trim().toUpperCase().replace(":", "|");
        const symbol = this.keyToSymbolMap.get(normalizedKey);
        if (!symbol) {
          logger.warn({ key: normalizedKey }, "Unmapped key from Upstox WS");
          continue;
        }

        let lastPrice = 0;
        let volume = 0;
        let bid: number | null = null;
        let ask: number | null = null;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((feed as any).ltpc) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastPrice = Number((feed as any).ltpc.ltp ?? 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } else if ((feed as any).ff) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ff = (feed as any).ff;
          if (ff.marketFF) {
            const marketFF = ff.marketFF;
            lastPrice = Number(marketFF.ltpc?.ltp ?? 0);
            volume = Number(marketFF.eFeedDetails?.tv ?? 0);
            const bidAsk = marketFF.marketLevel?.bidAskQuote;
            if (bidAsk && bidAsk.length > 0) {
              bid = Number(bidAsk[0].bp ?? 0) || null;
              ask = Number(bidAsk[0].ap ?? 0) || null;
            }
          } else if (ff.indexFF) {
            const indexFF = ff.indexFF;
            lastPrice = Number(indexFF.ltpc?.ltp ?? 0);
          }
        }

        if (lastPrice <= 0) {
          logger.warn({ key: normalizedKey, feed: JSON.stringify(feed) }, "Last price is <= 0");
          continue;
        }

        logger.debug(`Publishing marketTick: ${symbol} ${lastPrice}`);
        intelligenceBus.publish("marketTick", {
          instrumentKey: normalizedKey,
          symbol,
          ltp: lastPrice,
          volume: volume || 100000,
          bid,
          ask,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Failed to decode/parse Upstox WS message");
    }
  }

  updateSubscriptions(stocks: Array<{ symbol: string; key: string }>) {
    this.subscribedKeys.clear();
    this.symbolToKeyMap.clear();
    this.keyToSymbolMap.clear();

    for (const stock of stocks) {
      const originalKey = stock.key.trim().replace(":", "|");
      const canonicalKey = originalKey.toUpperCase();
      this.subscribedKeys.add(originalKey);
      this.symbolToKeyMap.set(stock.symbol, originalKey);
      this.keyToSymbolMap.set(canonicalKey, stock.symbol); // keep canonical for mapping incoming feeds safely
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribeToAll();
    }
  }

  private subscribeToAll() {
    const batchSize = 100;
    const keysArray = Array.from(this.subscribedKeys);
    
    // Separate indices and equities
    const indexKeys = keysArray.filter(k => k.includes("_INDEX"));
    const equityKeys = keysArray.filter(k => !k.includes("_INDEX"));

    const sendBatches = (keys: string[], mode: string, prefix: string) => {
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        if (batch.length === 0) continue;

        if (this.FeedResponse) {
          const msg = {
            guid: `${prefix}-${i}`,
            method: "sub",
            data: {
              mode: mode,
              instrumentKeys: batch,
            },
          };
          this.ws?.send(Buffer.from(JSON.stringify(msg)));
        }
      }
    };

    sendBatches(indexKeys, "ltpc", "cm-idx");
    sendBatches(equityKeys, "ltpc", "cm-eq");
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    const baseDelay = 2000;
    const maxDelay = 60000;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts++;

    const exponentialDelay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
    const jitter = Math.random() * 2000; // up to 2 seconds of random jitter
    const delay = exponentialDelay + jitter;

    logger.info({ delayMs: Math.round(delay), attempt: attempt }, "Scheduling Upstox WS reconnect...");

    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  getStatus() {
    return {
      connected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      connecting: this.isConnecting,
      lastTickReceivedAt: this.lastTickReceivedAt,
      subscribedCount: this.subscribedKeys.size,
      consecutiveFailures: this.consecutiveFailures,
      circuitBreakerActive: Date.now() < this.circuitBreakerCooldownUntil,
      reconnectAttempts: this.reconnectAttempts,
      cooldownRemainingMs: Math.max(0, this.circuitBreakerCooldownUntil - Date.now()),
    };
  }

  private startFallbackPolling() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);

    this.fallbackTimer = setInterval(async () => {
      const now = Date.now();
      const wsIsActive = this.ws && this.ws.readyState === WebSocket.OPEN;
      const receivedRecentTicks = now - this.lastTickReceivedAt < 10000;

      if (wsIsActive && !receivedRecentTicks && (now - this.lastTickReceivedAt > 30000)) {
        logger.warn("WebSocket silent for 30s, forcing reconnect.");
        if (this.ws) this.ws.close();
      }

      if (wsIsActive && receivedRecentTicks) return;
      if (this.subscribedKeys.size === 0) return;

      const token = getAccessToken("data");
      if (!token) return;

      try {
        const keys = Array.from(this.subscribedKeys);
        this.publishStatus("connecting", "upstox_http_fallback", "WebSocket silent or inactive");
        const prices = await this.upstoxClient.fetchLTPForInstruments(keys, token);

        for (const [key, price] of Object.entries(prices)) {
          if (typeof price !== "number" || isNaN(price) || price <= 0) continue;

          const canonicalKey = key.trim().toUpperCase().replace(":", "|");
          const symbol = this.keyToSymbolMap.get(canonicalKey);
          if (!symbol) continue;

          intelligenceBus.publish("marketTick", {
            instrumentKey: canonicalKey,
            symbol,
            ltp: price,
            volume: 100000,
            timestamp: Date.now(),
          });
        }
        this.publishStatus("connected", "upstox_http_fallback");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        logger.debug({ err: err.message }, "LTP fallback polling failed");
      }
    }, FALLBACK_POLL_INTERVAL_MS);
  }

  disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}

export const upstoxConnectionManager = new UpstoxConnectionManager();
