import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "../lib/logger";
import { parseClientEvent, ServerEvent, createServerEvent, packr } from "./events";
import { isAllowedOrigin } from "../lib/security";
import { Redis } from "ioredis";

const redisSubscriber = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
redisSubscriber.subscribe("mimir:alerts:pubsub").catch(err => logger.error({ err }, "Failed to subscribe to alerts"));
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

export function initWebSocketServer(server: Server): void {
  const wssIntelligence = new WebSocketServer({ noServer: true });
  const wssMarketData = new WebSocketServer({ noServer: true });

  wssInstances.push(wssIntelligence, wssMarketData);

  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    
    if (origin && !isAllowedOrigin(origin)) {
      console.error("401 Unauthorized in UPGRADE", { origin, isAllowed: isAllowedOrigin(origin), nodeEnv: process.env.NODE_ENV, headers: request.headers });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const pathname = request.url ? request.url.split("?")[0] : "";
    if (pathname === "/ws/intelligence") {
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
    wss.on("connection", (ws) => {
      connectedCount++;
      logger.info({ connectedClients: connectedCount, channel: name }, "WebSocket client connected");

      // Mark alive for heartbeat tracking and initialize default topics and symbol subscription
      const tc = ws as WebSocket & { isAlive: boolean; topics: Set<string>; activeSymbol: string | null; subscribedSymbols: Set<string>; channelName: string };
      tc.isAlive = true;
      tc.topics = new Set(["suggestions", "alerts"]); // default low-frequency subscription
      tc.activeSymbol = null; // no symbol subscription until client specifies
      tc.subscribedSymbols = new Set<string>();
      tc.channelName = name;

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
          } else if (clientEvent.event === "subscribe_symbol") {
            const symbol = clientEvent.data.symbol;
            const oldSymbol = tc.activeSymbol;
            tc.activeSymbol = symbol;
            logger.debug({ symbol, channel: tc.channelName }, "Client subscribed to symbol");
            // Also automatically subscribe to "ticks" topic when symbol is specified
            tc.topics.add("ticks");

            if (symbol) {
              import("../market_data/monitored_symbols").then(({ addManualMonitoredSymbol }) => {
                void addManualMonitoredSymbol(symbol).catch(() => {});
              }).catch(() => {});
            }

            if (oldSymbol && oldSymbol !== symbol) {
              // Clean up old activeSymbol monitoring if no other client is currently subscribing to it
              const otherSubscribed = Array.from(wssInstances.flatMap(w => Array.from(w.clients))).some((client) => {
                const tcClient = client as WebSocket & { activeSymbol?: string | null };
                return tcClient !== ws && tcClient.activeSymbol === oldSymbol;
              });

              if (!otherSubscribed) {
                import("../market_data/monitored_symbols").then(({ removeManualMonitoredSymbol }) => {
                  void removeManualMonitoredSymbol(oldSymbol).catch(() => {});
                }).catch(() => {});
              }
            }
          } else if (clientEvent.event === "subscribe_symbols" || clientEvent.event === "subscribe_watchlist") {
            const symbols = Array.isArray(clientEvent.data.symbols) ? clientEvent.data.symbols : [];
            symbols.forEach((sym: string) => {
              if (sym && typeof sym === "string") tc.subscribedSymbols.add(sym.trim());
            });
            tc.topics.add("ticks");
            logger.debug({ count: symbols.length, channel: tc.channelName }, "Client subscribed to symbol batch/watchlist");

            if (symbols.length > 0) {
              import("../market_data/monitored_symbols").then(({ addManualMonitoredSymbols }) => {
                void addManualMonitoredSymbols(symbols).catch(() => {});
              }).catch(() => {});
            }
          }
        } catch (err) {
          logger.error({ err }, "Error handling WebSocket message");
        }
      });

      ws.on("close", () => {
        connectedCount--;
        logger.info({ connectedClients: connectedCount, channel: tc.channelName }, "WebSocket client disconnected");
        
        const oldSymbol = tc.activeSymbol;
        if (oldSymbol) {
          // Clean up old activeSymbol monitoring if no other client is currently subscribing to it
          const otherSubscribed = Array.from(wss?.clients || []).some((client) => {
            const tcClient = client as WebSocket & { activeSymbol?: string | null };
            return tcClient !== ws && tcClient.activeSymbol === oldSymbol;
          });

          if (!otherSubscribed) {
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
  }, 30000);

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
        const tc = client as WebSocket & { topics?: Set<string>; activeSymbol?: string | null; channelName?: string; subscribedSymbols?: Set<string> };
        if (tc.readyState === WebSocket.OPEN) {
          // Enforce channel routing
          if (isTickEvent && tc.channelName === "intelligence") return;
          if (!isTickEvent && tc.channelName === "market-data" && topic !== "monitoring") return;

          if (topic === "all" || !tc.topics || tc.topics.has(topic)) {
            // Extra filtering: if this is a tick update, filter by activeSymbol + subscribedSymbols + indices
            if (isTickEvent && Array.isArray(event.data)) {
              if (event.data.length === 0) return;
              client.send(packr.pack(event));
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
      logger.info({ 
        event: event.event, 
        topic,
        clients: successCount 
      }, "Outbound WebSocket broadcast");
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
