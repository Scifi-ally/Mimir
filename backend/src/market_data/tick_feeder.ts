import { logger } from "../lib/logger";
import { stateStore } from "../lib/redis_state";
import { yahooFinance } from "../lib/yahoo-client";
import { broadcast } from "../ws/websocket_server";
import { createServerEvent } from "../ws/events";
import { intelligenceBus } from "../intelligence/event_bus";
import { tickDistribution } from "./tick_distribution";
import { initSectorRotation, updateSectorFlowFromTick } from "../analysis/sector_rotation";
import { getISTDateStr } from "../lib/ist-time";
import { isMarketOpen } from "./market_state";

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
  /** Tick-rule order flow, created on first tick. */
  flow?: TickRuleFlow;
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

/**
 * Tick-rule order flow, in [-1, +1].
 *
 * WHY THIS REPLACED QUOTE PRESSURE. The previous implementation derived this
 * feature from where the last trade sat inside the bid-ask spread. That never
 * fired in production: connection_manager.ts only extracts bid/ask from the `ff`
 * (full-form) branch, and the subscribed `ltpc` feed carries no quote at all.
 * So `upstox:features:<symbol>` was never written, and because
 * signal_generator.ts treats a missing realtime feature as rankerIncomplete,
 * the one calibrated model in the system was disarmed for the whole session -
 * the exact failure this writer exists to prevent.
 *
 * Upstox's ltpc payload DOES carry ltp and volume on every tick. Tick-rule
 * order flow uses only those two, so it is available on the feed we already pay
 * for, with no subscription change.
 *
 * METHOD. Each tick's volume is classified by the tick rule - a trade at a
 * higher price than the previous tick is buyer-initiated, lower is
 * seller-initiated - and the running buy/sell totals give
 * (buy - sell) / (buy + sell). Positive means buyers are lifting more volume
 * than sellers are hitting.
 *
 * This is a proxy for order flow, not order-book imbalance, which needs resting
 * bid/ask quantities from the market-depth feed. The feature key stays
 * `bidAskImbalance` because the 32-key ranker contract is pinned across the
 * TypeScript source, the training manifest and ranker_meta.json; renaming it
 * would invalidate the trained model for no accuracy gain.
 *
 * Returns null when there is nothing to classify yet, so "no data" stays
 * distinguishable from "balanced" - collapsing those is what let a missing
 * quote read as a neutral reading.
 */
export class TickRuleFlow {
  /** Direction of the last price move: 1 up, -1 down, 0 unknown. */
  private prevPrice = 0;
  private buyVol = 0;
  private sellVol = 0;
  /** Direction carried through unchanged ticks, per the standard tick rule. */
  private lastDir = 0;

  constructor(private readonly window: number = 200) {}

  /**
   * Fold in one tick. `volume` is the CUMULATIVE session volume from the feed,
   * not a per-tick delta, so the first difference is used to avoid counting the
   * whole day's volume on tick one.
   */
  push(price: number, cumulativeVolume: number): number | null {
    if (!Number.isFinite(price) || price <= 0) return null;
    if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0) return null;

    const delta = this.prevPrice === 0 ? 0 : cumulativeVolume - this.lastVolume;
    this.lastVolume = cumulativeVolume;

    if (this.prevPrice !== 0) {
      if (price > this.prevPrice) this.lastDir = 1;
      else if (price < this.prevPrice) this.lastDir = -1;
      // An unchanged price carries the previous direction forward, which is the
      // standard tick rule and is why a flat tape does not read as neutral flow.
    }
    this.prevPrice = price;

    if (delta > 0 && this.lastDir !== 0) {
      if (this.lastDir > 0) this.buyVol += delta;
      else this.sellVol += delta;
      if (this.buyVol + this.sellVol > this.window) {
        // Decay rather than reset: the feature stays responsive instead of
        // snapping to zero each time the window fills.
        this.buyVol *= 0.5;
        this.sellVol *= 0.5;
      }
    }

    const total = this.buyVol + this.sellVol;
    if (total <= 0) return null;
    return Math.max(-1, Math.min(1, (this.buyVol - this.sellVol) / total));
  }

  private lastVolume = 0;

  reset(): void {
    this.prevPrice = 0;
    this.lastVolume = 0;
    this.lastDir = 0;
    this.buyVol = 0;
    this.sellVol = 0;
  }
}

const subscriptions = new Map<string, StockSubscription>();

/**
 * optionsOiChangeRate has no producer anywhere in this repository: the only
 * option-chain source is NIFTY-wide and cached, so there is no per-symbol OI
 * series to differentiate. Null records that the measurement is unavailable.
 */
const OPTIONS_OI_CHANGE_RATE_UNAVAILABLE = null;

async function publishRealtimeFeatures(
  symbol: string,
  flow: number | null,
  timestamp: Date | number,
): Promise<void> {
  // null means nothing could be classified yet. Writing 0 instead would report
  // "balanced flow" for a symbol we have never actually observed.
  if (flow === null) return;

  const iso = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  await stateStore.saveRealtimeFeatures(symbol, {
    bidAskImbalance: flow,
    optionsOiChangeRate: OPTIONS_OI_CHANGE_RATE_UNAVAILABLE,
    timestamp: iso,
  });
}
let redisBatchQueue: Record<string, TickData[]> = {};
let redisBatchTimer: ReturnType<typeof setInterval> | null = null;
let volumePollerTimer: ReturnType<typeof setInterval> | null = null;
let eventBusUnsubscribe: (() => void) | null = null;
let reconnectUnsubscribe: (() => void) | null = null;
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
      // Drop ticks for unmonitored symbols: auto-creating entries here made the
      // subscriptions map grow unbounded on any stray bus tick.
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

    if (lastPrice === sub.lastPrice && volume === sub.volume && bid === sub.bid && ask === sub.ask) {
      return; // Ignore completely unchanged ticks
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

    // Publish realtime features to Redis.
    //
    // This is the only writer for `upstox:features:<symbol>`. Nothing else in
    // the repo wrote it, and stateStore.getRealtimeFeatures() returning null is
    // what sets `rankerIncomplete = true` in signal_generator.ts - which sent
    // ranker_features: null for every production candidate, disarming the only
    // calibrated model in the system along with its confidence blend and its
    // Kelly position sizing.
    //
    // Written fire-and-forget on purpose: this runs on every tick for every
    // subscribed symbol, and blocking the feed on a Redis round-trip would
    // couple quote latency to cache latency. A dropped write is self-healing -
    // it just means the next tick retries, and staleness is caught downstream.
    void publishRealtimeFeatures(
    sub.symbol,
    (sub.flow ??= new TickRuleFlow()).push(lastPrice, volume),
    tickEvent.timestamp,
  );

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
        const cached = tickDistribution.getCacheSnapshot(sub.symbol);
        const changePct = cached?.changePercent ?? null;
        // "monitoring" topic: market-data channel filter only passes non-tick events with this topic
        broadcast(createServerEvent.indicesUpdate({ [prop]: { ltp: lastPrice, changePct } }), "monitoring");
      }
    }

    // 2. Defer state updates and Redis buffering
    setImmediate(() => {
      if (!redisBatchQueue[sub.symbol]) {
        redisBatchQueue[sub.symbol] = [];
      }
      redisBatchQueue[sub.symbol].push(tick);

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
    if (!isMarketOpen()) return; // Yahoo quotes are meaningless off-session

    try {
      // Indices carry "_INDEX" in their instrumentKey (e.g. "NSE_INDEX|Nifty 50");
      // appending .NS to their symbol would poison the Yahoo batch.
      const symbolsToFetch = Array.from(subscriptions.values())
        .filter(sub => !sub.instrumentKey.includes("_INDEX")) // Only fetch for equities
        .map(sub => sub.symbol);

      if (symbolsToFetch.length === 0) return;

      // Map to Yahoo Finance symbols
      const yfSymbols = symbolsToFetch.map(s => `${s}.NS`);
      type YQuote = { symbol?: string; regularMarketPrice?: number; regularMarketVolume?: number };
      const quotes = await (yahooFinance.quote as (s: string[]) => Promise<YQuote[]>)(yfSymbols);

      const quoteMap = new Map<string, YQuote>();
      for (const quote of quotes) {
         if (quote.symbol) {
             // Remove .NS suffix to match back
             const baseSymbol = quote.symbol.replace(".NS", "");
             quoteMap.set(baseSymbol, quote);
         }
      }

      for (const sub of subscriptions.values()) {
        const quote = quoteMap.get(sub.symbol);
        if (quote) {
          const volume = Number(quote.regularMarketVolume || 0);
          // Yahoo prices are delayed: never overwrite a live WS price. Only use
          // the delayed price when the last WS update is stale (>120s) or absent.
          const wsStale = !sub.updatedAt || Date.now() - sub.updatedAt > 120_000;
          const yahooPrice = Number(quote.regularMarketPrice || 0);
          const price = wsStale && yahooPrice > 0 ? yahooPrice : Number(sub.lastPrice || 0);

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
  redisBatchQueue = {};
}
