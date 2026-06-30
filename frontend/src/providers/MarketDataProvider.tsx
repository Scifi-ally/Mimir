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
  
  private telemetry: MarketTelemetry = {
    fps: 60,
    ticksPerSec: 0,
    totalTicksReceived: 0,
    queueHighWaterMark: 0,
    lastBatchLatencyMs: 0,
    activeSymbolListeners: 0,
  };

  private frameCount = 0;
  private lastFpsTime = performance.now();

  constructor() {
    if (typeof window !== "undefined") {
      const loop = () => {
        this.frameCount++;
        const now = performance.now();
        if (now - this.lastFpsTime >= 1000) {
          this.telemetry.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsTime));
          this.frameCount = 0;
          this.lastFpsTime = now;
          this.notifyTelemetry();
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  // Priority: WebSocket tick > REST quote > cached last value
  // Never returns undefined — always returns last known good value
  get(symbol: string): SymbolData {
    let existing = this.data.get(symbol);
    if (!existing) {
      existing = this.getDefaultData(symbol);
      this.data.set(symbol, existing);
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
    const existing = this.data.get(symbol) ?? this.getDefaultData(symbol);
    const newLtp = tick.ltp ?? tick.price ?? existing.ltp;
    let direction: 'up' | 'down' | 'none' = 'none';
    if (newLtp !== null && existing.ltp !== null) {
      if (newLtp > existing.ltp) direction = 'up';
      else if (newLtp < existing.ltp) direction = 'down';
    } else if (tick.direction) {
      direction = tick.direction;
    }

    this.data.set(symbol, {
      ...existing,
      ltp: newLtp,
      change_pct: tick.change_pct ?? tick.changePct ?? existing.change_pct,
      volume: tick.volume ?? existing.volume,
      timestamp: tick.timestamp ?? Date.now(),
      source: 'websocket',
      direction,
      is_transitioning: false,
    });
    this.notify(symbol);
  }
  
  // Called when market:analysis WebSocket event arrives
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateFromAnalysis(symbol: string, analysis: any): void {
    const existing = this.data.get(symbol) ?? this.getDefaultData(symbol);
    this.data.set(symbol, {
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
    this.notify(symbol);
  }
  
  // Called when REST query resolves
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateFromRest(symbol: string, quote: any): void {
    const existing = this.data.get(symbol) ?? this.getDefaultData(symbol);
    // Only update price if no WebSocket data (REST is lower priority)
    if (existing.source !== 'websocket') {
      this.data.set(symbol, {
        ...existing,
        ltp: quote.ltp ?? existing.ltp,
        change_pct: quote.change_pct ?? existing.change_pct,
        source: 'rest',
        is_transitioning: false,
      });
      this.notify(symbol);
    }
  }
  
  markTransitioning(symbol: string): void {
    const existing = this.data.get(symbol) ?? this.getDefaultData(symbol);
    this.data.set(symbol, { ...existing, is_transitioning: true });
    setTimeout(() => {
      const current = this.data.get(symbol);
      if (current?.is_transitioning) {
        this.data.set(symbol, { ...current, is_transitioning: false });
        this.notify(symbol);
      }
    }, 1000);
    this.notify(symbol);
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
      scan_status: 'unknown', is_transitioning: false,
    };
  }
  
  subscribe(symbol: string, callback: () => void): () => void {
    if (!this.subscribers.has(symbol)) {
      this.subscribers.set(symbol, new Set());
    }
    this.subscribers.get(symbol)!.add(callback);
    this.telemetry.activeSymbolListeners++;
    return () => {
      this.subscribers.get(symbol)?.delete(callback);
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

// React hook for components
export function useSymbolData(symbol: string): SymbolData {
  const subscribe = useCallback(
    (cb: () => void) => marketDataStore.subscribe(symbol, cb),
    [symbol]
  );
  return useSyncExternalStore(subscribe, () => marketDataStore.get(symbol));
}

export function useMarketTelemetry(): MarketTelemetry {
  return useSyncExternalStore(
    (cb) => marketDataStore.subscribeTelemetry(cb),
    () => marketDataStore.getTelemetry()
  );
}
