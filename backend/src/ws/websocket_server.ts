import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "../lib/logger";
import { parseClientEvent, ServerEvent, createServerEvent, packr } from "./events";
import { isAllowedOrigin, isPrivateOrLocalIp } from "../lib/security";
import { createRedisClient } from "../lib/redis";

const redisSubscriber = createRedisClient("ws-subscriber");
redisSubscriber.connect().then(() => {
  return redisSubscriber.subscribe("mimir:alerts:pubsub");
}).catch(err => logger.error({ err }, "Failed to subscribe to alerts"));
redisSubscriber.on("message", (channel: string, message: string) => {
  if (channel === "mimir:alerts:pubsub") {
    try {
      const alertPayload = JSON.parse(message);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      broadcast({ event: "alert", data: alertPayload } as any, "alerts");
    } catch (err) {
      logger.error({ err }, "Failed to parse alert from Redis");
    }
  }
});

const wssInstances: WebSocketServer[] = [];
let connectedCount = 0;
let lastTickLog = 0;

// Backpressure: skip high-frequency tick sends to clients whose socket send
// buffer has grown past this. Ticks are ephemeral — dropping a batch for a
// slow reader is correct; letting the buffer grow unbounded is a memory leak.
// Terminate outright past the hard cap (client answers pings but never reads).
const TICK_BACKPRESSURE_BYTES = 1 * 1024 * 1024;
const HARD_BACKPRESSURE_BYTES = 16 * 1024 * 1024;

// SECURITY FIX (Issue #41): Rate limiting for auth attempts.
// Module-scoped so bans persist across reconnects — a per-connection map
// would reset on every new socket, letting attackers bypass the ban.
const authAttempts = new Map<string, { count: number; firstAttempt: number; banned: boolean; bannedAt: number }>();
const AUTH_RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 60000, // 1 minute
  banDurationMs: 300000 // 5 minutes
};

// Prune expired entries so the map cannot grow unbounded from one-off IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, t] of authAttempts) {
    const expired = t.banned
      ? now - t.bannedAt > AUTH_RATE_LIMIT.banDurationMs
      : now - t.firstAttempt > AUTH_RATE_LIMIT.windowMs;
    if (expired) authAttempts.delete(ip);
  }
}, 60000).unref();

// Single normalization point for all subscribe/unsubscribe symbol paths —
// mismatched casing here corrupts cross-client eviction decisions.
function normalizeSymbol(sym: unknown): string {
  return typeof sym === "string" ? sym.trim().toUpperCase() : "";
}

// A symbol is still needed if ANY other client watches it via activeSymbol
// OR batch/watchlist subscribedSymbols — checking only activeSymbol tears
// down feeds that watchlist clients still depend on.
function isSymbolStillNeeded(symbol: string, exceptClient: WebSocket): boolean {
  const allClients = wssInstances.reduce((acc, w) => acc.concat(Array.from(w.clients)), [] as WebSocket[]);
  return allClients.some((client) => {
    const tcClient = client as WebSocket & { activeSymbol?: string | null; subscribedSymbols?: Set<string> };
    return tcClient !== exceptClient && (tcClient.activeSymbol === symbol || tcClient.subscribedSymbols?.has(symbol) === true);
  });
}

export function initWebSocketServer(server: Server): void {
  const wssIntelligence = new WebSocketServer({ noServer: true });
  const wssMarketData = new WebSocketServer({ noServer: true });

  wssInstances.push(wssIntelligence, wssMarketData);

  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    
    if (origin && !isAllowedOrigin(origin)) {
      logger.error({ origin, isAllowed: isAllowedOrigin(origin), nodeEnv: process.env.NODE_ENV, headers: request.headers }, "401 Unauthorized in UPGRADE");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const pathname = request.url ? request.url.split("?")[0] : "";
    if (pathname === "/ws/intelligence" || pathname === "/ws") {
      wssIntelligence.handleUpgrade(request, socket, head, (ws) => {
        wssIntelligence.emit("connection", ws, request);
      });
    } else if (pathname === "/ws/market-data") {
      wssMarketData.handleUpgrade(request, socket, head, (ws) => {
        wssMarketData.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const setupWs = (wss: WebSocketServer, name: string) => {
    wss.on("connection", (ws, request) => {
      connectedCount++;
      logger.info({ connectedClients: connectedCount, channel: name }, "WebSocket client connected");

      // Mark alive for heartbeat tracking and initialize default topics and symbol subscription
      const tc = ws as WebSocket & { isAlive: boolean; topics: Set<string>; activeSymbol: string | null; subscribedSymbols: Set<string>; channelName: string; isAuthenticated: boolean };
      tc.isAlive = true;
      tc.topics = new Set<string>(); // default topics assigned only after auth succeeds
      tc.activeSymbol = null; // no symbol subscription until client specifies
      tc.subscribedSymbols = new Set<string>();
      tc.channelName = name;
      tc.isAuthenticated = false;

      const ipStr = request?.socket?.remoteAddress;
      // SECURITY FIX (Issue #39): Timing-safe token comparison with proper padding
      // Always use constant-time comparison regardless of length to prevent timing attacks
      const normalizedIp = (ipStr || "").replace(/^::ffff:/, "");
      const isLocal = isPrivateOrLocalIp(normalizedIp);
      const isTokenConfigured = Boolean(process.env.UPSTOXBOT_ADMIN_TOKEN?.trim());
      const isRemoteAuthDisabled = process.env.DISABLE_REMOTE_API_AUTH === "1" || process.env.DISABLE_REMOTE_API_AUTH === "true" || !isTokenConfigured;

      // CRITICAL FIX (Issue #6): Store timeout ID and clear it after successful auth
      let authTimeoutId: NodeJS.Timeout | null = null;

      if (isLocal || isRemoteAuthDisabled) {
        tc.isAuthenticated = true;
        tc.topics.add("suggestions").add("alerts").add("ticks"); // default subscriptions
      } else {
        // Enforce 5-second auth timeout
        authTimeoutId = setTimeout(() => {
          if (!tc.isAuthenticated) {
            logger.warn({ channel: tc.channelName }, "Closing WS connection: Auth timeout");
            ws.close(4001, "Authentication timeout");
          }
        }, 5000);
      }

      ws.on("pong", () => {
        tc.isAlive = true;
      });

      ws.on("message", (raw) => {
        try {
          tc.isAlive = true; // Any message from client means it's alive
          
          let clientEvent;
          if (Buffer.isBuffer(raw) && raw[0] === 123) { 
            // 123 is '{', fallback for JSON strings sent as buffers
            clientEvent = parseClientEvent(raw.toString());
          } else if (typeof raw === "string") {
            clientEvent = parseClientEvent(raw);
          } else {
            // Binary MsgPack payload
            clientEvent = parseClientEvent(raw as Buffer);
          }

          if (!clientEvent) {
            logger.warn("Received invalid client event");
            return;
          }

          logger.info({ 
            event: clientEvent.event, 
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            topic: (clientEvent.data as any)?.topic, 
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            symbol: (clientEvent.data as any)?.symbol,
            channel: tc.channelName
          }, "Inbound WebSocket message");

          // Handle client events
          if (clientEvent.event === "auth") {
            // Already authenticated (e.g. local connection) — skip re-processing.
            // Without this guard, a local client that sends an auth token while
            // UPSTOXBOT_ADMIN_TOKEN is unset would have its connection closed with
            // 4003 "Remote access disabled", killing an already-working session.
            if (tc.isAuthenticated) {
              logger.debug({ channel: tc.channelName }, "Ignoring auth event — client already authenticated");
              return;
            }
            // SECURITY FIX (Issue #41): Check rate limit before processing auth
            const now = Date.now();
            const tracker = authAttempts.get(normalizedIp) || {
              count: 0,
              firstAttempt: now,
              banned: false,
              bannedAt: 0,
            };

            // Ban duration is tracked from bannedAt, NOT firstAttempt — the
            // old code reset `banned` on window expiry (60s), silently
            // shortening the 5-minute ban to one minute.
            if (tracker.banned) {
              if (now - tracker.bannedAt < AUTH_RATE_LIMIT.banDurationMs) {
                logger.warn({
                  ip: normalizedIp,
                  attempts: tracker.count,
                  channel: tc.channelName
                }, "WebSocket auth blocked - rate limit exceeded");
                ws.close(4429, "Too many authentication attempts");
                return;
              }
              // Ban expired — clean slate
              tracker.count = 0;
              tracker.firstAttempt = now;
              tracker.banned = false;
              tracker.bannedAt = 0;
            } else if (now - tracker.firstAttempt > AUTH_RATE_LIMIT.windowMs) {
              // Attempt window expired (not banned)
              tracker.count = 0;
              tracker.firstAttempt = now;
            }

            // Increment attempt counter
            tracker.count++;
            authAttempts.set(normalizedIp, tracker);

            const token = clientEvent.data?.token;
            const expectedToken = process.env.UPSTOXBOT_ADMIN_TOKEN?.trim();
            if (!expectedToken) {
              ws.close(4003, "Remote access disabled");
              return;
            }
            if (!token) {
              ws.close(4001, "Token required");
              return;
            }
            
            try {
              // SECURITY FIX (Issue #39): Pad buffers to prevent length-based timing leak
              const left = Buffer.from(token);
              const right = Buffer.from(expectedToken);
              
              // Always compare same length buffers
              const maxLen = Math.max(left.length, right.length);
              const paddedLeft = Buffer.concat([left, Buffer.alloc(maxLen - left.length)]);
              const paddedRight = Buffer.concat([right, Buffer.alloc(maxLen - right.length)]);
              
              // Now timing-safe for both length and content
              if (!crypto.timingSafeEqual(paddedLeft, paddedRight) || left.length !== right.length) {
                throw new Error("Invalid token");
              }
              
              tc.isAuthenticated = true;
              tc.topics.add("suggestions").add("alerts"); // default low-frequency subscription

              // Success - reset rate limit tracker
              authAttempts.delete(normalizedIp);
              
              // CRITICAL FIX (Issue #6): Clear auth timeout after successful authentication
              if (authTimeoutId) {
                clearTimeout(authTimeoutId);
                authTimeoutId = null;
              }
              
              logger.info({ channel: tc.channelName }, "WS client authenticated successfully");
            } catch {
              // Failed auth - check if should ban
              if (tracker.count >= AUTH_RATE_LIMIT.maxAttempts) {
                tracker.banned = true;
                tracker.bannedAt = Date.now();
                authAttempts.set(normalizedIp, tracker);
                logger.warn({ 
                  ip: normalizedIp, 
                  attempts: tracker.count 
                }, "WebSocket IP banned for repeated auth failures");
              }
              ws.close(4001, "Invalid token");
            }
            return;
          }

          if (!tc.isAuthenticated && clientEvent.event !== "ping") {
            logger.warn({ event: clientEvent.event }, "Ignoring event from unauthenticated client");
            return;
          }

          if (clientEvent.event === "ping") {
            ws.send(packr.pack(createServerEvent.pong()));
          } else if (clientEvent.event === "subscribe") {
            const topic = clientEvent.data.topic;
            tc.topics.add(topic);
            logger.debug({ topic, channel: tc.channelName }, "Client subscribed to topic");
          } else if (clientEvent.event === "unsubscribe") {
            const topic = clientEvent.data.topic;
            tc.topics.delete(topic);
            logger.debug({ topic, channel: tc.channelName }, "Client unsubscribed from topic");
          } else if (clientEvent.event === "unsubscribe_symbol") {
            const symbol = normalizeSymbol(clientEvent.data.symbol);
            if (symbol) {
              if (tc.activeSymbol === symbol) tc.activeSymbol = null;
              tc.subscribedSymbols.delete(symbol);

              if (!isSymbolStillNeeded(symbol, ws)) {
                import("../market_data/monitored_symbols").then(({ removeManualMonitoredSymbol }) => {
                  void removeManualMonitoredSymbol(symbol).catch(() => {});
                }).catch(() => {});
              }
            }
            logger.debug({ symbol, channel: tc.channelName }, "Client unsubscribed from symbol");
          } else if (clientEvent.event === "subscribe_symbol") {
            const symbol = normalizeSymbol(clientEvent.data.symbol);
            const oldSymbol = tc.activeSymbol;
            tc.activeSymbol = symbol || null;
            logger.debug({ symbol, channel: tc.channelName }, "Client subscribed to symbol");
            // Also automatically subscribe to "ticks" topic when symbol is specified
            tc.topics.add("ticks");

            if (symbol) {
              import("../market_data/monitored_symbols").then(({ addManualMonitoredSymbol }) => {
                void addManualMonitoredSymbol(symbol).catch(() => {});
              }).catch(() => {});
            }

            if (oldSymbol && oldSymbol !== symbol && !tc.subscribedSymbols.has(oldSymbol)) {
              // Clean up old activeSymbol monitoring if no other client is currently subscribing to it
              if (!isSymbolStillNeeded(oldSymbol, ws)) {
                import("../market_data/monitored_symbols").then(({ removeManualMonitoredSymbol }) => {
                  void removeManualMonitoredSymbol(oldSymbol).catch(() => {});
                }).catch(() => {});
              }
            }
          } else if (clientEvent.event === "subscribe_symbols" || clientEvent.event === "subscribe_watchlist") {
            const symbols = Array.isArray(clientEvent.data.symbols) ? clientEvent.data.symbols : [];
            const normalized = symbols.map((sym: unknown) => normalizeSymbol(sym)).filter((sym: string) => sym.length > 0);
            normalized.forEach((sym: string) => tc.subscribedSymbols.add(sym));
            tc.topics.add("ticks");
            logger.debug({ count: normalized.length, channel: tc.channelName }, "Client subscribed to symbol batch/watchlist");

            if (normalized.length > 0) {
              import("../market_data/monitored_symbols").then(({ addManualMonitoredSymbols }) => {
                void addManualMonitoredSymbols(normalized).catch(() => {});
              }).catch(() => {});
            }
          }
        } catch (err) {
          logger.error({ err }, "Error handling WebSocket message");
        }
      });

      ws.on("close", () => {
        if (authTimeoutId) {
          clearTimeout(authTimeoutId);
          authTimeoutId = null;
        }
        connectedCount--;
        logger.info({ connectedClients: connectedCount, channel: tc.channelName }, "WebSocket client disconnected");
        
        const oldSymbol = tc.activeSymbol;
        if (oldSymbol) {
          // Clean up old activeSymbol monitoring if no other client is currently subscribing to it
          if (!isSymbolStillNeeded(oldSymbol, ws)) {
            import("../market_data/monitored_symbols").then(({ removeManualMonitoredSymbol }) => {
              void removeManualMonitoredSymbol(oldSymbol).catch(() => {});
            }).catch(() => {});
          }
        }
      });

      ws.on("error", (err) => {
        logger.error({ err, channel: tc.channelName }, "WebSocket client error");
      });

      // Send initial connection confirmation (silent — UI shows Live/Offline in top bar)
      broadcastToClient(ws, createServerEvent.pong());
    });
  };

  setupWs(wssIntelligence, "intelligence");
  setupWs(wssMarketData, "market-data");

  // Server-side heartbeat: terminate dead connections every 30s
  setInterval(() => {
    wssInstances.forEach((wss) => {
      wss.clients.forEach((ws) => {
        const alive = ws as WebSocket & { isAlive: boolean };
        if (alive.isAlive === false) {
          logger.warn("Terminating unresponsive WebSocket client");
          ws.terminate();
          return;
        }
        alive.isAlive = false;
        ws.ping();
      });
    });
  }, 30000).unref();

  logger.info("WebSocket servers initialized at /ws/intelligence and /ws/market-data");
}

/**
 * Send a typed event to a single client
 */
export function broadcastToClient(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(packr.pack(event));
  }
}

/**
 * Broadcast a typed event to all connected clients
 */
let broadcastFn = (event: ServerEvent, topic: string = "suggestions"): void => {
  const isTickEvent = event.event === "tick_update" || topic === "ticks";
  const execute = () => {
    let successCount = 0;
    
    wssInstances.forEach((wss) => {
      wss.clients.forEach((client) => {
        const tc = client as WebSocket & { topics?: Set<string>; activeSymbol?: string | null; channelName?: string; subscribedSymbols?: Set<string>; isAuthenticated?: boolean };
        if (tc.readyState === WebSocket.OPEN && tc.isAuthenticated) {
          // A reader that answers pings but never drains its socket would grow
          // server memory unbounded — the heartbeat can't catch it.
          if (tc.bufferedAmount > HARD_BACKPRESSURE_BYTES) {
            logger.warn({ bufferedAmount: tc.bufferedAmount }, "Terminating WebSocket client: send buffer exceeded hard cap");
            tc.terminate();
            return;
          }
          // Enforce channel routing
          if (isTickEvent && tc.channelName === "intelligence") return;
          if (!isTickEvent && tc.channelName === "market-data" && topic !== "monitoring") return;
          // Drop tick batches (only) for slow readers; low-frequency analysis
          // events still queue so state-changing messages aren't lost.
          if (isTickEvent && tc.bufferedAmount > TICK_BACKPRESSURE_BYTES) return;

          if (topic === "all" || !tc.topics || tc.topics.has(topic)) {
            // Tick batches are high frequency. Only send symbols this client has
            // explicitly requested; analysis events remain topic based.
            // MEDIUM FIX (Issue #15): Enhanced tick filtering with validation
            if (isTickEvent && Array.isArray(event.data)) {
              const requested = new Set<string>();
              tc.subscribedSymbols?.forEach((s) => requested.add(s.toUpperCase()));
              if (tc.activeSymbol) requested.add(tc.activeSymbol.toUpperCase());

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ticks = (event.data as any[]).filter((tick) => {
                if (!tick || (typeof tick !== 'object' && !Array.isArray(tick))) {
                  return false;
                }

                const symbol = Array.isArray(tick) ? tick[0] : tick.symbol;
                if (typeof symbol !== "string" || symbol.length === 0) return false;
                if (requested.size === 0) return false;

                const rawUpper = symbol.trim().toUpperCase();
                if (requested.has(rawUpper)) return true;

                const cleanTick = rawUpper
                  .replace(/^(NSE_INDEX|NSE_EQ|BSE_INDEX|NSE|BSE)[:|]/, "")
                  .replace(/-EQ$/, "")
                  .replace(/[^A-Z0-9]/g, "");

                for (const req of requested) {
                  if (req === rawUpper) return true;
                  const cleanReq = req
                    .replace(/^(NSE_INDEX|NSE_EQ|BSE_INDEX|NSE|BSE)[:|]/, "")
                    .replace(/-EQ$/, "")
                    .replace(/[^A-Z0-9]/g, "");

                  if (cleanReq === cleanTick && cleanReq.length > 0) return true;
                  if ((cleanReq === "NIFTY50" || cleanReq === "NIFTY") && (cleanTick === "NIFTY50" || cleanTick === "NIFTY")) return true;
                  if (cleanReq === "BANKNIFTY" && cleanTick === "BANKNIFTY") return true;
                  if (cleanReq === "FINNIFTY" && cleanTick === "FINNIFTY") return true;
                  if ((cleanReq === "INDIAVIX" || cleanReq === "VIX") && (cleanTick === "INDIAVIX" || cleanTick === "VIX")) return true;
                }

                return false;
              });
              if (ticks.length === 0) return;
              client.send(packr.pack({ ...event, data: ticks }));
              successCount++;
              return;
            }

            client.send(packr.pack(event));
            successCount++;
          }
        }
      });
    });

    if (successCount > 0) {
      // Debug level: broadcast() already logs at info with connectedCount;
      // this one carries the actual recipient count for deep debugging.
      logger.debug({
        event: event.event,
        topic,
        clients: successCount
      }, "Outbound WebSocket broadcast delivered");
    }
  };

  if (isTickEvent) {
    execute();
  } else {
    setImmediate(execute);
  }
};

export function broadcast(event: ServerEvent, topic: string = "system") {
  if (topic !== "ticks") {
    logger.info({ event: event.event, topic, clients: connectedCount }, "Outbound WebSocket broadcast");
  } else {
    if (Date.now() - lastTickLog > 5000) {
      lastTickLog = Date.now();
      logger.info({ event: event.event, topic, clients: connectedCount }, "Outbound WebSocket broadcast (ticks throttle)");
    }
  }
  broadcastFn(event, topic);
}

export function setBroadcastFn(fn: typeof broadcastFn): void {
  broadcastFn = fn;
}

/**
 * Get the number of connected clients
 */
export function getConnectedClients(): number {
  let count = 0;
  for (const instance of wssInstances) {
    for (const client of instance.clients) {
      if (client.readyState === WebSocket.OPEN) count++;
    }
  }
  return count;
}

/**
 * Export types for consumers
 */
export type { ServerEvent } from "./events";

/**
 * High-performance batched tick broadcaster
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function broadcastMarketTicks(ticks: any[]): void {
  if (!ticks || ticks.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broadcast({ event: "tick_update", data: ticks } as any, "ticks");
}
