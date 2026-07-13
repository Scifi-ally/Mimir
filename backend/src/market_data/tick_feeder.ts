import { logger } from "../lib/logger";
import { stateStore } from "../lib/redis_state";
import { createUpstoxClient } from "../lib/upstox-client";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { intelligenceBus } from "../intelligence/event_bus";
import { getAccessToken } from "../upstox/auth";
import { tickDistribution } from "./tick_distribution";
import { initSectorRotation, updateSectorFlowFromTick } from "../analysis/sector_rotation";

interface TickData {
  symbol: string;
  price: number;
  volume: number;
  bid: number;
  ask: number;
  timestamp: Date;
}

interface StockSubscription {
  instrumentKey: string;
  symbol: string;
  ticks: TickData[];
  lastPrice: number | null;
  volume: number;
  bid: number | null;
  ask: number | null;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  updatedAt?: number;
}

const MAX_TICKS_PER_STOCK = Math.max(
  40,
  Number(process.env["MAX_TICKS_PER_STOCK"] ?? "80"),
);

const subscriptions = new Map<string, StockSubscription>();
let tickUpdateQueue: TickData[] = [];
let redisBatchQueue: Record<string, TickData[]> = {};
let redisBatchTimer: ReturnType<typeof setInterval> | null = null;
let volumePollerTimer: ReturnType<typeof setInterval> | null = null;
let eventBusUnsubscribe: (() => void) | null = null;
let reconnectUnsubscribe: (() => void) | null = null;
let lastTickTimestamp: number = 0;

/**
 * Initialize tick feeder - subscribe to watchlist stocks
 */
export async function initTickFeeder(stocks: Array<{ symbol: string; key: string }>): Promise<void> {
  if (!stocks.length) {
    logger.warn("No stocks provided for tick feeder initialization");
    return;
  }

  // Clear existing
  stopTickFeeder();

  // Initialize subscription map
  for (const stock of stocks) {
    const cachedTicks = await stateStore.getTicks(stock.symbol).catch(() => []);
    const lastTick = cachedTicks.length > 0 ? cachedTicks[cachedTicks.length - 1] : null;
    const firstTick = cachedTicks.length > 0 ? cachedTicks[0] : null;

    subscriptions.set(stock.symbol, {
      instrumentKey: stock.key,
      symbol: stock.symbol,
      ticks: cachedTicks.map(t => ({ ...t, timestamp: new Date(t.timestamp) })),
      lastPrice: lastTick ? lastTick.price : null,
      volume: lastTick ? lastTick.volume : 0,
      bid: lastTick ? lastTick.bid : null,
      ask: lastTick ? lastTick.ask : null,
      openPrice: firstTick ? firstTick.price : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      highPrice: cachedTicks.length > 0 ? Math.max(...cachedTicks.map((t: any) => t.price)) : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lowPrice: cachedTicks.length > 0 ? Math.min(...cachedTicks.map((t: any) => t.price)) : null,
    });
  }

  logger.info(
    { stockCount: stocks.length, symbols: stocks.map((s) => s.symbol).slice(0, 10) },
    "Initializing event-driven tick feeder wrapper",
  );

  const prevCloses: Record<string, number> = {};
  for (const [sym, sub] of subscriptions.entries()) {
    if (sub.lastPrice) prevCloses[sym] = sub.lastPrice;
  }
  initSectorRotation(prevCloses);

  // Subscribe to central connection manager tick stream via internal event bus
  eventBusUnsubscribe = intelligenceBus.subscribe("marketTick", (tickEvent) => {
    const sub = subscriptions.get(tickEvent.symbol);
    if (!sub) {
      if (process.env["LOG_UNMONITORED_TICKS"] === "1") {
        logger.debug({ symbol: tickEvent.symbol }, "Ignored tick for non-monitored symbol");
      }
      return;
    }

    if (Date.now() - tickEvent.timestamp > 2000) {
      if (process.env["LOG_UNMONITORED_TICKS"] === "1") {
        logger.debug({ symbol: tickEvent.symbol, delay: Date.now() - tickEvent.timestamp }, "Dropped severely delayed tick (Stale Tick Dropper)");
      }
      return;
    }

    const lastPrice = tickEvent.ltp;
    const volume = tickEvent.volume || sub.volume || 100000;
    const bid = tickEvent.bid ?? lastPrice - 0.05;
    const ask = tickEvent.ask ?? lastPrice + 0.05;

    if (lastPrice === sub.lastPrice && volume === sub.volume) {
      return; // Ignore unchanged ticks
    }

    sub.lastPrice = lastPrice;
    sub.volume = volume;
    sub.bid = bid;
    sub.ask = ask;
    sub.updatedAt = tickEvent.timestamp;

    const tick: TickData = {
      symbol: sub.symbol,
      price: lastPrice,
      timestamp: new Date(tickEvent.timestamp),
      volume,
      bid,
      ask,
    };

    // 1. Ingest into Institutional Tick Distribution Server (handles cache, workers, batched UI streaming)
    tickDistribution.ingestTick({
      symbol: sub.symbol,
      price: lastPrice,
      ltp: lastPrice,
      volume,
      bid,
      ask,
      timestamp: tick.timestamp.getTime(),
    });

    // 2. Update real-time sector rotation engine
    updateSectorFlowFromTick(sub.symbol, lastPrice, volume);

    const INDICES_SYMBOLS = new Set(["NIFTY 50", "BANKNIFTY", "FINNIFTY", "INDIA VIX", "SENSEX"]);
    if (INDICES_SYMBOLS.has(sub.symbol)) {
      let prop = "";
      if (sub.symbol === "NIFTY 50") prop = "nifty";
      else if (sub.symbol === "BANKNIFTY") prop = "banknifty";
      else if (sub.symbol === "FINNIFTY") prop = "finnifty";
      else if (sub.symbol === "INDIA VIX") prop = "vix";
      else if (sub.symbol === "SENSEX") prop = "sensex";

      if (prop) {
        broadcast(createServerEvent.indicesUpdate({ [prop]: { ltp: lastPrice, changePct: null } }), "all");
      }
    }

    // 2. Defer state updates and Redis buffering
    setImmediate(() => {
      if (!redisBatchQueue[sub.symbol]) {
        redisBatchQueue[sub.symbol] = [];
      }
      redisBatchQueue[sub.symbol].push(tick);

      lastTickTimestamp = Date.now();
    });
  });

  // Subscribe to reconnect events to backfill missing gaps
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reconnectUnsubscribe = intelligenceBus.subscribe("websocketReconnect" as any, async (event: any) => {
      const durationMs = event.durationMs;
      if (durationMs > 60000) {
          logger.info({ gap: Math.round(durationMs/1000) + "s" }, "WebSocket was offline for >1m. Triggering historical backfill for Nifty and top stocks...");
          // We would trigger a call to upstox API to fetch missing 1m candles here
          // For now we just log it as the gap will be filled in the nightly archive, but 
          // real-time technicals may be slightly skewed until next restart.
          // TODO: Implement actual historical candle fetch and inject into tickDistribution
      }
  });

  startRedisBatcher();
  startVolumePoller();
  startTickBroadcaster();
}

/**
 * Start Volume Poller - fetches volume for all subscribed equities every minute
 */
function startVolumePoller(): void {
  if (volumePollerTimer) clearInterval(volumePollerTimer);

  volumePollerTimer = setInterval(async () => {
    if (subscriptions.size === 0) return;

    try {
      const token = getAccessToken();
      if (!token) return;

      const keysToFetch = Array.from(subscriptions.values())
        .map(sub => sub.instrumentKey)
        .filter(k => !k.includes("_INDEX")); // Only fetch for equities

      if (keysToFetch.length === 0) return;

      const upstoxApiClient = createUpstoxClient();
      const quotes = await upstoxApiClient.fetchQuotesForInstruments(keysToFetch, token);

      for (const sub of subscriptions.values()) {
        if (quotes[sub.instrumentKey]) {
          const quote = quotes[sub.instrumentKey];
          const volume = Number(quote.volume || 0);
          const price = sub.lastPrice || Number(quote.last_price || 0);

          if (volume > 0 && price > 0) {
            sub.volume = volume;
            sub.lastPrice = price;
            // Also broadcast updated volume
            broadcast(createServerEvent.tickUpdate([{
              symbol: sub.symbol,
              price: price,
              volume: volume,
              bid: sub.bid || 0,
              ask: sub.ask || 0,
              timestamp: new Date().toISOString()
            }]), "ticks");
          }
        }
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to poll volume data");
    }
  }, 60000); // Poll every minute
}

/**
 * Start Redis batcher - flushes buffered ticks to Redis periodically
 */
function startRedisBatcher(): void {
  if (redisBatchTimer) clearInterval(redisBatchTimer);

  redisBatchTimer = setInterval(() => {
    if (Object.keys(redisBatchQueue).length === 0) return;

    const currentBatch = redisBatchQueue;
    redisBatchQueue = {}; // Reset immediately to collect new ticks

    void stateStore.batchPushTicks(currentBatch, MAX_TICKS_PER_STOCK).catch(() => {});
  }, 1000); // Flush every second
}

function startTickBroadcaster(): void {
  // Deprecated: Ticks are now broadcasted synchronously in the event subscriber
}

/**
 * Get current tick data for a symbol
 */
export function getTickData(symbol: string): TickData[] {
  const subscription = subscriptions.get(symbol);
  return subscription?.ticks ?? [];
}

/**
 * Get latest price for a symbol
 */
export function getLatestPrice(symbol: string): number | null {
  const subscription = subscriptions.get(symbol);
  return subscription?.lastPrice ?? null;
}

/**
 * Get OHLC data for a symbol
 */
export function getOHLC(symbol: string): { open: number; high: number; low: number; close: number } | null {
  const subscription = subscriptions.get(symbol);
  if (!subscription || !subscription.lastPrice) return null;

  return {
    open: subscription.openPrice ?? subscription.lastPrice,
    high: subscription.highPrice ?? subscription.lastPrice,
    low: subscription.lowPrice ?? subscription.lastPrice,
    close: subscription.lastPrice,
  };
}

/**
 * Stop tick feeder and clean up
 */
export function stopTickFeeder(): void {
  logger.info("Stopping tick feeder wrapper");

  if (eventBusUnsubscribe) {
    eventBusUnsubscribe();
    eventBusUnsubscribe = null;
  }
  
  if (reconnectUnsubscribe) {
    reconnectUnsubscribe();
    reconnectUnsubscribe = null;
  }



  if (redisBatchTimer) {
    clearInterval(redisBatchTimer);
    redisBatchTimer = null;
  }

  if (volumePollerTimer) {
    clearInterval(volumePollerTimer);
    volumePollerTimer = null;
  }

  subscriptions.clear();
  tickUpdateQueue = [];
  redisBatchQueue = {};
}

/**
 * Get feeder status
 */
export function getTickFeederStatus() {
  return {
    connected: subscriptions.size > 0 && lastTickTimestamp > 0,
    subscriptionsCount: subscriptions.size,
    queuedTicks: tickUpdateQueue.length,
    lastTickTimestamp,
    subscriptions: Array.from(subscriptions.values()).map((s) => ({
      symbol: s.symbol,
      lastPrice: s.lastPrice,
      bid: s.bid,
      ask: s.ask,
      volume: s.volume,
      ticksRecorded: s.ticks.length,
    })),
  };
}
