/**
 * Institutional Tick Distribution Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Decouples raw websocket tick ingestion from UI streaming and ML analysis.
 * Features:
 * - O(1) object-pooled in-memory tick cache.
 * - Timestamp normalization and stale/duplicate sequence dropping.
 * - Non-blocking asynchronous event dispatch to analysis engines.
 * - Frame-aligned batching (30-60 FPS) for UI WebSocket clients.
 * - Comprehensive diagnostic telemetry.
 */

import { logger } from "../lib/logger";
import { loadBalancer } from "../intelligence/load_balancer";
import { broadcastMarketTicks } from "../ws/websocket_server";
import { intelligenceBus } from "../intelligence/event_bus";

const UI_TICK_FLUSH_MS = Math.max(
  1,
  Number(process.env["UI_TICK_FLUSH_MS"] ?? "10"),
);

export interface NormalizedTick {
  symbol: string;
  instrumentKey?: string;
  ltp: number;
  bid: number;
  ask: number;
  volume: number;
  oi?: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  timestamp: number;
  sequence?: number;
}

export interface DiagnosticsTelemetry {
  feedLatencyMs: number;
  ticksPerSec: number;
  droppedTicks: number;
  totalTicksProcessed: number;
  cacheSize: number;
  batchQueueSize: number;
  lastFlushDurationMs: number;
}

class TickDistributionServer {
  // O(1) Symbol lookup cache
  private tickCache = new Map<string, NormalizedTick>();
  private historyCache = new Map<string, NormalizedTick[]>();
  private readonly MAX_HISTORY_MS = 5 * 60 * 1000; // 5 mins
  private readonly MAX_HISTORY_PER_SYMBOL = 1000;
  
  // Pre-allocated array for UI streaming (MAX 5000 pending ticks per flush)
  private batchPool: unknown[] = new Array(5000);
  
  // Dirty symbols pending UI flush
  private pendingUISymbols = new Set<string>();
  
  // Telemetry counters
  private totalTicks = 0;
  private droppedTicks = 0;
  private ticksInCurrentSecond = 0;
  private currentTicksPerSec = 0;
  private lastFeedLatency = 0;
  private lastFlushDuration = 0;
  private intervals: NodeJS.Timeout[] = [];
  


  constructor() {
    this.startTimers();
  }

  private startTimers(): void {
    // UI stream flushes in millisecond-scale batches. Analysis dispatch remains
    // per valid tick below; this interval only controls browser/network batching.
    this.intervals.push(setInterval(() => this.flushUIStream(), UI_TICK_FLUSH_MS));

    // Calculate ticks/sec every 1 second
    this.intervals.push(setInterval(() => {
      this.currentTicksPerSec = this.ticksInCurrentSecond;
      this.ticksInCurrentSecond = 0;
    }, 1000));
    
    // Cleanup history cache every minute
    this.intervals.push(setInterval(() => this.cleanupHistoryCache(), 60000));
  }

  public stop(): void {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
  }

  private cleanupHistoryCache(): void {
    const cutoff = Date.now() - this.MAX_HISTORY_MS;
    for (const [symbol, hist] of this.historyCache.entries()) {
      // If the most recent tick in history is older than the cutoff, remove the symbol entirely
      if (hist.length > 0 && hist[hist.length - 1].timestamp < cutoff) {
        this.historyCache.delete(symbol);
      }
    }
  }

  /**
   * Ingest a raw or normalized tick from Upstox feed service
   */
  public ingestTick(rawTick: Partial<NormalizedTick> & { symbol: string; price?: number }): void {
    const now = Date.now();
    const tickTime = rawTick.timestamp ? Number(rawTick.timestamp) : now;
    
    // Normalize price fields
    const ltp = rawTick.ltp ?? rawTick.price ?? 0;
    if (ltp <= 0) {
      this.droppedTicks++;
      return;
    }

    // Measure latency
    this.lastFeedLatency = Math.max(0, now - tickTime);
    
    // Drop out-of-sequence ticks: if this tick is stamped more than 1000ms
    // BEFORE the newest tick we already have for the symbol, it arrived late /
    // out of order, so we keep the fresher cached value.
    const existing = this.tickCache.get(rawTick.symbol);
    if (existing && tickTime < existing.timestamp - 1000) {
      this.droppedTicks++;
      return;
    }

    // --- Intelligent Load Balancing ---
    const mode = loadBalancer.getTickFeedMode();
    
    // Complete pause during offline scans
    if (mode === "paused") {
      this.droppedTicks++;
      return;
    }

    let shouldStreamToUI = true;

    // Throttled mode during live market scans: filter micro-ticks only from
    // UI streaming. Analysis still receives every valid tick below.
    // NOTE: Aggressive throttling removed because requestAnimationFrame and Worker batching
    // already handle UI performance efficiently without dropping visual ticks.
    // ----------------------------------

    this.totalTicks++;
    this.ticksInCurrentSecond++;

    // Acquire or update normalized object in O(1) cache without re-allocating
    let normalized = existing;
    if (!normalized) {
      normalized = {
        symbol: rawTick.symbol,
        instrumentKey: rawTick.instrumentKey,
        ltp: ltp,
        bid: rawTick.bid ?? ltp,
        ask: rawTick.ask ?? ltp,
        volume: rawTick.volume ?? 0,
        timestamp: tickTime,
        sequence: rawTick.sequence,
      };
      this.tickCache.set(rawTick.symbol, normalized);
      
    }

    normalized.ltp = Math.round(ltp * 100) / 100;
    normalized.bid = rawTick.bid ?? normalized.bid;
    normalized.ask = rawTick.ask ?? normalized.ask;
    normalized.volume = rawTick.volume ?? normalized.volume;
    normalized.oi = rawTick.oi ?? normalized.oi;
    normalized.open = rawTick.open ?? normalized.open;
    normalized.high = rawTick.high ? Math.max(rawTick.high, normalized.ltp) : (normalized.high ? Math.max(normalized.high, normalized.ltp) : normalized.ltp);
    normalized.low = rawTick.low ? Math.min(rawTick.low, normalized.ltp) : (normalized.low ? Math.min(normalized.low, normalized.ltp) : normalized.ltp);
    normalized.timestamp = tickTime;

    if (normalized.open && normalized.open > 0) {
      normalized.change = Math.round((normalized.ltp - normalized.open) * 100) / 100;
      normalized.changePercent = Math.round((normalized.change / normalized.open) * 10000) / 100;
    } else if (rawTick.changePercent !== undefined) {
      normalized.changePercent = rawTick.changePercent;
      normalized.change = rawTick.change;
    }

    if (shouldStreamToUI) {
      this.pendingUISymbols.add(rawTick.symbol);
    }

    const history = this.historyCache.get(rawTick.symbol) ?? [];
    if (!this.historyCache.has(rawTick.symbol)) {
      this.historyCache.set(rawTick.symbol, history);
    }
    history.push({ ...normalized });
    const cutoff = tickTime - this.MAX_HISTORY_MS;
    while (history.length > this.MAX_HISTORY_PER_SYMBOL || history[0]?.timestamp < cutoff) {
      history.shift();
    }

    // NON-BLOCKING ASYNC DISPATCH TO ANALYSIS ENGINE
    // Uses 'processedTick' (not 'marketTick') to avoid circular re-ingestion by tick_feeder.
    //
    // `normalized` is the shared, mutated-in-place cache entry. The setImmediate
    // callback runs on a later macrotask, so reading `normalized.*` inside it
    // would publish whatever the LATEST mutation left there — if two ticks for
    // this symbol are ingested in the same macrotask, both queued callbacks would
    // read the final state and publish the newest values twice, losing the
    // intermediate tick. Snapshot the primitives NOW so each dispatch carries the
    // exact values from its own ingest.
    const snapshot = {
      instrumentKey: normalized.instrumentKey || normalized.symbol,
      symbol: normalized.symbol,
      ltp: normalized.ltp,
      volume: normalized.volume,
      bid: normalized.bid,
      ask: normalized.ask,
      timestamp: normalized.timestamp,
      source: "ws" as const,
    };
    setImmediate(() => {
      try {
        intelligenceBus.publish("processedTick", snapshot);
      } catch (err) {
        logger.warn({ err }, "Suppressed error: failed to publish processedTick to intelligenceBus");
      }
    });
  }

  /**
   * Flush pending delta ticks to subscribed WebSocket clients
   */
  private flushUIStream(): void {
    if (this.pendingUISymbols.size === 0) return;

    const start = performance.now();
    let batchLength = 0;

    for (const symbol of this.pendingUISymbols) {
      const cached = this.tickCache.get(symbol);
      if (cached) {
        // [symbol, ltp, volume, bid, ask, timestamp, change_pct]
        this.batchPool[batchLength++] = [
          cached.symbol,
          cached.ltp,
          cached.volume,
          cached.bid,
          cached.ask,
          cached.timestamp,
          cached.changePercent ?? null
        ];
      }
    }
    this.pendingUISymbols.clear();

    if (batchLength > 0) {
      try {
        const payload = this.batchPool.slice(0, batchLength);
        broadcastMarketTicks(payload);
        
        // Clear slots to prevent memory leaks of tick objects
        for (let i = 0; i < batchLength; i++) {
          this.batchPool[i] = undefined;
        }
      } catch (err) {
        logger.error({ err }, "Failed to broadcast UI tick stream");
      }
    }

    this.lastFlushDuration = Math.round((performance.now() - start) * 100) / 100;
  }

  public getCacheSnapshot(symbol: string): NormalizedTick | undefined {
    return this.tickCache.get(symbol);
  }

  public getAllCachedTicks(): NormalizedTick[] {
    return Array.from(this.tickCache.values());
  }

  public getDiagnostics(): DiagnosticsTelemetry {
    return {
      feedLatencyMs: Math.round(this.lastFeedLatency),
      ticksPerSec: this.currentTicksPerSec,
      droppedTicks: this.droppedTicks,
      totalTicksProcessed: this.totalTicks,
      cacheSize: this.tickCache.size,
      batchQueueSize: this.pendingUISymbols.size,
      lastFlushDurationMs: this.lastFlushDuration,
    };
  }
  public getTickHistory(symbol: string): NormalizedTick[] {
    return this.historyCache.get(symbol) || [];
  }
}

export const tickDistribution = new TickDistributionServer();
