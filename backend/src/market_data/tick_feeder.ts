import { logger } from "../lib/logger";
import { stateStore } from "../lib/redis_state";
import { createUpstoxClient } from "../lib/upstox-client";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { intelligenceBus } from "../intelligence/event_bus";
import { getAccessToken } from "../upstox/auth";
import { tickDistribution } from "./tick_distribution";
import { initSectorRotation, updateSectorFlowFromTick } from "../analysis/sector_rotation";
import { getISTDateStr } from "../lib/ist-time";

interface TickData {
  symbol: string;
  price: number;
  volume: number;
  // null = the feed did not carry a quote for this tick. Never synthesize a
  // spread: downstream liquidity/circuit-limit guards in paper_engine treat a
  // null/zero bid or ask as "no liquidity", and a fabricated ±0.05 spread would
  // both mask that condition and defeat the spread-blowout abort.
  bid: number | null;
  ask: number | null;
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
let initPromise: Promise<void> = Promise.resolve();

/**
 * Initialize tick feeder - subscribe to watchlist stocks
 *
 * Serialized via a module-level promise chain: overlapping calls (e.g. from
 * concurrent syncMonitoredSubscriptions) would otherwise both see
 * eventBusUnsubscribe === null across the awaits and leak a duplicate
 * marketTick handler.
 */
export function initTickFeeder(stocks: Array<{ symbol: string; key: string }>): Promise<void> {
  initPromise = initPromise.catch(() => {}).then(() => doInitTickFeeder(stocks));
  return initPromise;
}

async function doInitTickFeeder(stocks: Array<{ symbol: string; key: string }>): Promise<void> {
  if (!stocks.length) {
    logger.warn("No stocks provided for tick feeder initialization");
    return;
  }

  // Clear existing
  stopTickFeeder();

  // Initialize subscription map
  const todayISTStr = getISTDateStr();
  for (const stock of stocks) {
    const allCachedTicks = await stateStore.getTicks(stock.symbol).catch(() => []);
    // Redis keeps ticks for 24h, so a restart can restore the previous
    // session: only today's (IST) ticks may seed cumulative day volume,
    // open/high/low and history. A stale-day tick survives solely as the
    // last-known price/quote (it doubles as prev close for sector rotation).
    const cachedTicks = allCachedTicks.filter(t => {
      const ts = new Date(t.timestamp);
      return Number.isFinite(ts.getTime()) && getISTDateStr(ts) === todayISTStr;
    });
    const lastKnownTick = allCachedTicks.length > 0 ? allCachedTicks[allCachedTicks.length - 1] : null;
    const lastTick = cachedTicks.length > 0 ? cachedTicks[cachedTicks.length - 1] : null;
    const firstTick = cachedTicks.length > 0 ? cachedTicks[0] : null;

    subscriptions.set(stock.symbol, {
      instrumentKey: stock.key,
      symbol: stock.symbol,
      ticks: cachedTicks.map(t => ({ ...t, timestamp: new Date(t.timestamp) })),
      lastPrice: lastKnownTick ? lastKnownTick.price : null,
      volume: lastTick ? lastTick.volume : 0,
      bid: lastKnownTick ? lastKnownTick.bid : null,
      ask: lastKnownTick ? lastKnownTick.ask : null,
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
    // Never fabricate volume: carry last known real volume (sub.volume starts at 0 = unknown)
    const volume = tickEvent.volume ?? sub.volume;
    // Never fabricate a spread either. Carry the last known real quote; if we've
    // never seen one, leave it null so liquidity guards can see "no quote".
    const bid = tickEvent.bid ?? sub.bid;
    const ask = tickEvent.ask ?? sub.ask;

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

    // Maintain in-memory tick history for getTickData consumers
    sub.ticks.push(tick);
    if (sub.ticks.length > MAX_TICKS_PER_STOCK) {
      sub.ticks.splice(0, sub.ticks.length - MAX_TICKS_PER_STOCK);
    }
    if (sub.openPrice === null) sub.openPrice = lastPrice;
    if (sub.highPrice === null || lastPrice > sub.highPrice) sub.highPrice = lastPrice;
    if (sub.lowPrice === null || lastPrice < sub.lowPrice) sub.lowPrice = lastPrice;

    // 1. Ingest into Institutional Tick Distribution Server (handles cache, workers, batched UI streaming)
    tickDistribution.ingestTick({
      symbol: sub.symbol,
      price: lastPrice,
      ltp: lastPrice,
      volume,
      // tickDistribution's RawTick uses undefined for "absent"; map null→undefined.
      bid: bid ?? undefined,
      ask: ask ?? undefined,
      timestamp: tick.timestamp.getTime(),
    });

    // 2. Update real-time sector rotation engine (skip when volume unknown so the flow EMA isn't seeded with 0)
    if (volume > 0) {
      updateSectorFlowFromTick(sub.symbol, lastPrice, volume);
    }

    const INDICES_SYMBOLS = new Set(["NIFTY 50", "BANKNIFTY", "FINNIFTY", "INDIA VIX", "SENSEX"]);
    if (INDICES_SYMBOLS.has(sub.symbol)) {
      let prop = "";
      if (sub.symbol === "NIFTY 50") prop = "nifty";
      else if (sub.symbol === "BANKNIFTY") prop = "banknifty";
      else if (sub.symbol === "FINNIFTY") prop = "finnifty";
      else if (sub.symbol === "INDIA VIX") prop = "vix";
      else if (sub.symbol === "SENSEX") prop = "sensex";

      if (prop) {
        // "monitoring" topic: market-data channel filter only passes non-tick events with this topic
        broadcast(createServerEvent.indicesUpdate({ [prop]: { ltp: lastPrice, changePct: null } }), "monitoring");
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
          // No live backfill implemented — gap is filled by the nightly archive.
          // Log honestly so operators don't assume ticks were recovered.
          logger.warn({ gap: Math.round(durationMs/1000) + "s" }, "WebSocket was offline for >1m. Tick gap NOT backfilled; intraday technicals may be skewed until nightly archive or restart.");
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
      const token = getAccessToken("trading");
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
