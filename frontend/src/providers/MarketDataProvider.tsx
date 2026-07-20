import { useCallback, useSyncExternalStore } from "react";

export interface SymbolData {
  // Price — always defined (falls back through sources)
  ltp: number | null;
  change_pct: number | null;
  volume: number | null;
  timestamp: number | null;
  source: 'websocket' | 'rest' | 'cache';
  direction: 'up' | 'down' | 'none';
  
  // Analysis — may be null if not yet computed
  composite_score: number | null;
  watchlist_score: number | null;
  provisional_trigger: number | null;
  provisional_deviation: number | null;
  mtf_score: number | null;
  mtf_total: number | null;
  mtf_confluence: string | null;
  tech_edge: number | null;
  regime_align: number | null;
  
  // State
  scan_status: 'scanned' | 'watchlisted' | 'active_signal' | 'unknown';
  is_transitioning: boolean;  // true during source switch
  is_stale: boolean;          // true when the last live tick is older than STALE_TTL_MS
}

export interface MarketTelemetry {
  fps: number;
  ticksPerSec: number;
  totalTicksReceived: number;
  queueHighWaterMark: number;
  lastBatchLatencyMs: number;
  activeSymbolListeners: number;
}

class MarketDataStore {
  private data = new Map<string, SymbolData>();
  private subscribers = new Map<string, Set<() => void>>();
  private telemetrySubscribers = new Set<() => void>();

  private key(symbol: string): string {
    return symbol.trim().toUpperCase();
  }
  
  private telemetry: MarketTelemetry = {
    fps: 60,
    ticksPerSec: 0,
    totalTicksReceived: 0,
    queueHighWaterMark: 0,
    lastBatchLatencyMs: 0,
    activeSymbolListeners: 0,
  };

  private ticksSinceLastTelemetry = 0;

  // A price with a real feed source is considered stale this long after its last
  // tick. Without this, a dropped WebSocket left the last tick on screen forever,
  // presented as live — a frozen price a user could trade against. The sweep below
  // flips is_stale and re-notifies so LivePrice can dim / flag it.
  private static readonly STALE_TTL_MS = 10_000;

  constructor() {
    if (typeof window !== "undefined") {
      // 1s interval instead of a permanent requestAnimationFrame loop: the rAF
      // version forced the browser to run a frame callback ~60×/s forever —
      // even fully idle — keeping the main thread from ever going quiet and
      // starving other animations. Telemetry only needs 1Hz resolution.
      let lastTime = performance.now();
      setInterval(() => {
        const now = performance.now();
        this.telemetry.fps = 60; // no longer rAF-sampled; retained for shape-compat
        this.telemetry.ticksPerSec = Math.round(
          (this.ticksSinceLastTelemetry * 1000) / Math.max(1, now - lastTime),
        );
        this.telemetry.totalTicksReceived += this.ticksSinceLastTelemetry;
        this.ticksSinceLastTelemetry = 0;
        lastTime = now;
        this.notifyTelemetry();
        this.sweepStale();
      }, 1000);
    }
  }

  // Once per second: mark live-sourced prices stale after STALE_TTL_MS of silence.
  private sweepStale(): void {
    const nowMs = Date.now();
    for (const [k, d] of this.data.entries()) {
      if (d.source === 'cache' || d.timestamp == null) continue;
      const shouldBeStale = nowMs - d.timestamp > MarketDataStore.STALE_TTL_MS;
      if (shouldBeStale !== d.is_stale) {
        this.data.set(k, { ...d, is_stale: shouldBeStale });
        this.notify(k);
      }
    }
  }

  // Priority: WebSocket tick > REST quote > cached last value
  // Never returns undefined — always returns last known good value
  get(symbol: string): SymbolData {
    const k = this.key(symbol);
    let existing = this.data.get(k);
    if (!existing) {
      existing = this.getDefaultData(k);
      this.data.set(k, existing);
    }
    return existing;
  }

  getTelemetry(): MarketTelemetry {
    return this.telemetry;
  }

  updateTelemetry(metrics: Partial<MarketTelemetry>): void {
    this.telemetry = { ...this.telemetry, ...metrics };
    this.notifyTelemetry();
  }
  
  // Called when WebSocket tick arrives
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateFromTick(symbol: string, tick: any): void {
    const k = this.key(symbol);
    const existing = this.data.get(k) ?? this.getDefaultData(k);
    const newLtp = tick.ltp ?? tick.price ?? existing.ltp;
    let direction: 'up' | 'down' | 'none' = 'none';
    if (newLtp !== null && existing.ltp !== null) {
      if (newLtp > existing.ltp) direction = 'up';
      else if (newLtp < existing.ltp) direction = 'down';
    } else if (tick.direction) {
      direction = tick.direction;
    }

    const incomingChangePct = tick.change_pct ?? tick.changePct;
    const newChangePct = incomingChangePct != null ? incomingChangePct : existing.change_pct;
    const incomingVolume = tick.volume;
    const newVolume = incomingVolume != null ? incomingVolume : existing.volume;

    this.data.set(k, {
      ...existing,
      ltp: newLtp,
      change_pct: newChangePct,
      volume: newVolume,
      timestamp: tick.timestamp ?? Date.now(),
      source: 'websocket',
      direction,
      is_transitioning: false,
      is_stale: false,
    });
    this.notify(k);
    this.ticksSinceLastTelemetry++;
  }
  
  // Called when market:analysis WebSocket event arrives
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateFromAnalysis(symbol: string, analysis: any): void {
    const k = this.key(symbol);
    const existing = this.data.get(k) ?? this.getDefaultData(k);
    this.data.set(k, {
      ...existing,
      composite_score: analysis.composite_score,
      watchlist_score: analysis.watchlist_score,
      provisional_trigger: analysis.provisional_trigger,
      provisional_deviation: analysis.provisional_deviation,
      mtf_score: analysis.mtf_score,
      mtf_total: analysis.mtf_total,
      mtf_confluence: analysis.mtf_confluence,
      tech_edge: analysis.tech_edge,
      regime_align: analysis.regime_align,
    });
    this.notify(k);
    this.ticksSinceLastTelemetry++;
  }

  // Called when REST query resolves
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateFromRest(symbol: string, quote: any): void {
    const k = this.key(symbol);
    const existing = this.data.get(k) ?? this.getDefaultData(k);
    // Only update price if no WebSocket data (REST is lower priority)
    const shouldUpdatePrice = existing.source !== 'websocket';

    this.data.set(k, {
      ...existing,
      ltp: shouldUpdatePrice ? (quote.ltp ?? existing.ltp) : existing.ltp,
      change_pct: quote.change_pct ?? existing.change_pct,
      source: shouldUpdatePrice ? 'rest' : existing.source,
      is_transitioning: shouldUpdatePrice ? false : existing.is_transitioning,
      timestamp: shouldUpdatePrice ? Date.now() : existing.timestamp,
      is_stale: shouldUpdatePrice ? false : existing.is_stale,
    });
    this.notify(k);
  }

  markTransitioning(symbol: string): void {
    const k = this.key(symbol);
    const existing = this.data.get(k) ?? this.getDefaultData(k);
    this.data.set(k, { ...existing, is_transitioning: true });
    setTimeout(() => {
      const current = this.data.get(k);
      if (current?.is_transitioning) {
        this.data.set(k, { ...current, is_transitioning: false });
        this.notify(k);
      }
    }, 1000);
    this.notify(k);
  }
  
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private getDefaultData(_symbol: string): SymbolData {
    return {
      ltp: null, change_pct: null, volume: null, 
      timestamp: null, source: 'cache', direction: 'none',
      composite_score: null, watchlist_score: null,
      provisional_trigger: null, provisional_deviation: null,
      mtf_score: null, mtf_total: null, mtf_confluence: null,
      tech_edge: null, regime_align: null,
      scan_status: 'unknown', is_transitioning: false, is_stale: false,
    };
  }
  
  subscribe(symbol: string, callback: () => void): () => void {
    const k = this.key(symbol);
    if (!this.subscribers.has(k)) {
      this.subscribers.set(k, new Set());
    }
    this.subscribers.get(k)!.add(callback);
    this.telemetry.activeSymbolListeners++;
    return () => {
      const set = this.subscribers.get(k);
      if (set) {
        set.delete(callback);
        // Drop empty Sets so subscribers doesn't grow for every symbol ever rendered.
        // (data entries are intentionally kept — last-known-good cache for remounts.)
        if (set.size === 0) this.subscribers.delete(k);
      }
      this.telemetry.activeSymbolListeners = Math.max(0, this.telemetry.activeSymbolListeners - 1);
    };
  }

  subscribeTelemetry(callback: () => void): () => void {
    this.telemetrySubscribers.add(callback);
    return () => this.telemetrySubscribers.delete(callback);
  }
  
  private notify(symbol: string): void {
    this.subscribers.get(symbol)?.forEach(cb => cb());
  }

  private notifyTelemetry(): void {
    this.telemetrySubscribers.forEach(cb => cb());
  }
}

// Singleton — one instance for the entire app
export const marketDataStore = new MarketDataStore();

// React hook for components (gets whole object - CAUTION: causes re-renders on ANY field change)
export function useSymbolData(symbol: string): SymbolData {
  const subscribe = useCallback(
    (cb: () => void) => marketDataStore.subscribe(symbol, cb),
    [symbol]
  );
  return useSyncExternalStore(subscribe, () => marketDataStore.get(symbol));
}

// Optimized React hook for selecting specific primitives to prevent massive re-renders
export function useSymbolDataSelector<T>(symbol: string, selector: (data: SymbolData) => T): T {
  const subscribe = useCallback(
    (cb: () => void) => marketDataStore.subscribe(symbol, cb),
    [symbol]
  );
  // useSyncExternalStore will only trigger a re-render if the returned value (snapshot) changes
  // according to Object.is. This is perfect for primitive selectors like (d) => d.ltp
  const getSnapshot = useCallback(() => selector(marketDataStore.get(symbol)), [symbol, selector]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useMarketTelemetry(): MarketTelemetry {
  return useSyncExternalStore(
    (cb) => marketDataStore.subscribeTelemetry(cb),
    () => marketDataStore.getTelemetry()
  );
}
