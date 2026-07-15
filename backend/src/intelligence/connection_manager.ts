import { WebSocket } from "ws";
import path from "node:path";
import fs from "node:fs";
import protobuf from "protobufjs";
import axios from "axios";

import { logger } from "../lib/logger";
import { getAccessToken } from "../upstox/auth";
import { loadBalancer } from "./load_balancer";
import { intelligenceBus } from "./event_bus";
import { createUpstoxClient } from "../lib/upstox-client";
import type { ConnectionStatusEvent } from "./types";

const UPSTOX_AUTHORIZE_URL = "https://api.upstox.com/v3/feed/market-data-feed/authorize";



export class UpstoxConnectionManager {
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickReceivedAt = 0;
  private lastDisconnectTime: number | null = null;
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
      let dirname = "";
      try {
        dirname = typeof __dirname !== "undefined" ? __dirname : new URL('.', import.meta.url).pathname;
      } catch (err) {
        logger.warn({ err }, "Suppressed error: failed to resolve __dirname for protobuf schema path");
        dirname = process.cwd();
      }
      const possiblePaths = [
        path.resolve(dirname, "MarketDataFeed.proto"),
        path.resolve(dirname, "src/intelligence/MarketDataFeed.proto"),
        path.resolve(process.cwd(), "src/intelligence/MarketDataFeed.proto"),
        path.resolve(process.cwd(), "src/market_data/MarketDataFeed.proto"),
        path.resolve(process.cwd(), "backend/src/intelligence/MarketDataFeed.proto"),
        path.resolve(process.cwd(), "backend/src/market_data/MarketDataFeed.proto")
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

      const connectWs = (url: string) => {
        logger.info({ url: url.substring(0, 50) + "..." }, "Connecting to Upstox Market Data Feed WebSocket...");
        const ws = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
        this.ws = ws;

        ws.on("unexpected-response", (request, response) => {
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              logger.info({ redirectUrl: redirectUrl.substring(0, 50) + "..." }, "Following WebSocket redirect");
              
              // Mark this socket as redirected so we don't trigger reconnect loops
              (ws as WebSocket & { _isRedirecting?: boolean })._isRedirecting = true;
              request.abort();
              
              connectWs(redirectUrl);
            }
          } else {
            logger.error({ statusCode: response.statusCode }, "Unexpected server response during WebSocket handshake");
            this.isConnecting = false;
            this.publishStatus("failed", "upstox_ws", `Unexpected response: ${response.statusCode}`);
          }
        });

        ws.on("open", async () => {
          logger.info("Upstox WebSocket connected in Connection Manager");
          this.isConnecting = false;
          this.consecutiveFailures = 0;
          this.reconnectAttempts = 0;
          this.circuitBreakerCooldownUntil = 0;
          
          if (this.lastDisconnectTime) {
            const durationMs = Date.now() - this.lastDisconnectTime;
            logger.info({ durationMs }, "WebSocket reconnected after disconnect");
            intelligenceBus.publish("websocketReconnect", { durationMs });
            this.lastDisconnectTime = null;
          }
          
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

        ws.on("message", (raw) => {
          this.handleWsMessage(raw);
        });

        ws.on("close", (code, reason) => {
          // Ignore close event if we are just following a redirect
          if ((ws as WebSocket & { _isRedirecting?: boolean })._isRedirecting) return;
          
          const reasonStr = reason ? reason.toString() : "unknown close";
          logger.warn({ code, reason: reasonStr }, "Upstox WebSocket disconnected");
          this.lastDisconnectTime = Date.now();
          this.isConnecting = false;
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
            this.circuitBreakerCooldownUntil = Date.now() + this.circuitBreakerCooldownMs;
            logger.error({ cooldownMs: this.circuitBreakerCooldownMs }, "Upstox WS connection failures exceeded threshold. Circuit breaker tripped.");
          }
          this.publishStatus("disconnected", "upstox_ws", reasonStr);
          this.scheduleReconnect();
        });

        ws.on("error", (err) => {
          if ((ws as WebSocket & { _isRedirecting?: boolean })._isRedirecting) return;
          
          logger.error({ err }, "Upstox WebSocket error in Connection Manager");
          this.isConnecting = false;
          this.publishStatus("failed", "upstox_ws", err.message);
        });
      };

      connectWs(wsUrl);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error({ err }, "Failed to connect Upstox WebSocket in Connection Manager");
      this.isConnecting = false;
      this.consecutiveFailures++;

      // Check if it's an authorization failure (401/403 or invalid token msg)
      const isAuthErr =
        err?.response?.status === 401 ||
        err?.response?.status === 403 ||
        err?.response?.data?.errors?.[0]?.errorCode === "UDAPI100050" ||
        (typeof err?.response?.data?.errors?.[0]?.message === "string" && err.response.data.errors[0].message.toLowerCase().includes("invalid token"));

      if (isAuthErr) {
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

      let decoded;
      try {
        decoded = this.FeedResponse.decode(buffer);
      } catch (decodeErr) {
        logger.warn({ err: (decodeErr as Error).message, hex: Buffer.from(buffer).toString('hex') }, "Failed to decode/parse Upstox WS message");
        return;
      }
      
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
        const globalAny = global as typeof globalThis & { tickLogCount?: number };
        if (!globalAny.tickLogCount) globalAny.tickLogCount = 0;
        if (globalAny.tickLogCount++ < 5) logger.info({ feed: JSON.stringify(feed) }, "LOG_TICK_DEBUG");

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
            volume = parseInt(marketFF.eFeedDetails?.tv?.toString() || "0", 10);
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
          volume: volume || null,
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
    
    // Trigger immediate fallback fetch so UI gets instant updates when a new stock is added
    this.executeFallbackPoll(true);
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
    sendBatches(equityKeys, "full", "cm-eq");
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    const baseDelay = 2000;
    const maxDelay = 60000;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts++;

    let exponentialDelay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
    
    // Check if it's NSE market hours (09:15 to 15:30 IST Mon-Fri)
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = istTime.getDay();
    const timeValue = istTime.getHours() * 100 + istTime.getMinutes();
    
    const isMarketHours = day >= 1 && day <= 5 && timeValue >= 915 && timeValue <= 1530;
    
    if (!isMarketHours) {
      exponentialDelay = 300000; // Cap to 5 minutes during off-market hours
    }

    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      exponentialDelay = 100;
    }

    const jitter = Math.random() * 2000; // up to 2 seconds of random jitter
    const delay = exponentialDelay + (isMarketHours && !(process.env.NODE_ENV === "test" || process.env.VITEST) ? jitter : 0);

    logger.info({ delayMs: Math.round(delay), attempt: attempt, isMarketHours }, "Scheduling Upstox WS reconnect...");

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

  private async executeFallbackPoll(force: boolean = false) {
    const mode = loadBalancer.getTickFeedMode();
    if (mode === "paused") {
      // Pause fallback polling to free up 100% of Upstox API quotas for offline background scans
      return;
    }

    const now = Date.now();
    const wsIsActive = this.ws && this.ws.readyState === WebSocket.OPEN;
    const receivedRecentTicks = now - this.lastTickReceivedAt < 10000;

    if (wsIsActive && !receivedRecentTicks && (now - this.lastTickReceivedAt > 30000)) {
      logger.warn("WebSocket silent for 30s, forcing reconnect.");
      if (this.ws) this.ws.close();
    }

    if (!force && wsIsActive && receivedRecentTicks) return;
    if (this.subscribedKeys.size === 0) return;

    const token = getAccessToken("data");
    if (!token) return;

    try {
      const keys = Array.from(this.subscribedKeys);
      if (!force) this.publishStatus("connecting", "upstox_http_fallback", "WebSocket silent or inactive");
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
          volume: null,
          timestamp: Date.now(),
        });
      }
      if (!force) this.publishStatus("connected", "upstox_http_fallback");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.debug({ err: err.message }, "LTP fallback polling failed");
    }
  }

  private startFallbackPolling() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);

    // Poll every 2 seconds for ultra-responsive off-market UI (Upstox limit is 10 req/sec)
    this.fallbackTimer = setInterval(() => this.executeFallbackPoll(), 2000);
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
