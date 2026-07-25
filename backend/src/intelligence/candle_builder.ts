import type { Candle, MarketTickEvent, Timeframe } from "./types";

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export class CandleBuilderEngine {
  private readonly active = new Map<string, Candle>();
  private readonly buffers = new Map<string, Candle[]>();

  constructor(private readonly maxBufferSize: number) {}

  initializeBuffer(instrumentKey: string, timeframe: Timeframe, candles: Candle[]): void {
    const key = `${instrumentKey}:${timeframe}`;
    this.buffers.set(key, candles.slice(-this.maxBufferSize));
  }

  hasBuffer(instrumentKey: string, timeframe: Timeframe): boolean {
    return this.buffers.has(`${instrumentKey}:${timeframe}`);
  }

  clearBuffer(instrumentKey: string): void {
    for (const timeframe of Object.keys(TIMEFRAME_MS)) {
      this.buffers.delete(`${instrumentKey}:${timeframe}`);
      this.active.delete(`${instrumentKey}:${timeframe}`);
    }
  }

  applyTick(tick: MarketTickEvent): Candle[] {
    const closed: Candle[] = [];
    for (const timeframe of Object.keys(TIMEFRAME_MS) as Timeframe[]) {
      const key = `${tick.instrumentKey}:${timeframe}`;
      
      // Optimize: Only build and buffer candles if the buffer was initialized (active candidate)
      if (!this.buffers.has(key)) {
        continue;
      }

      const duration = TIMEFRAME_MS[timeframe];
      const startTime = Math.floor(tick.timestamp / duration) * duration;
      const current = this.active.get(key);

      if (!current || current.startTime !== startTime) {
        if (current) {
          const completed = { ...current, closed: true };
          this.pushBuffer(key, completed);
          closed.push(completed);
        }
        this.active.set(key, {
          instrumentKey: tick.instrumentKey,
          symbol: tick.symbol,
          timeframe,
          startTime,
          endTime: startTime + duration - 1,
          open: tick.ltp,
          high: tick.ltp,
          low: tick.ltp,
          close: tick.ltp,
          volume: tick.volume ?? 0,
          timestamp: new Date(startTime).toISOString(),
          closed: false,
        });
        continue;
      }

      current.high = Math.max(current.high, tick.ltp);
      current.low = Math.min(current.low, tick.ltp);
      current.close = tick.ltp;
      current.volume = Math.max(current.volume, tick.volume ?? 0);
    }
    return closed;
  }

  getCandles(instrumentKey: string, timeframe: Timeframe): Candle[] {
    return [...(this.buffers.get(`${instrumentKey}:${timeframe}`) ?? [])];
  }

  private pushBuffer(key: string, candle: Candle): void {
    const buffer = this.buffers.get(key) ?? [];
    buffer.push(candle);
    if (buffer.length > this.maxBufferSize) {
      buffer.splice(0, buffer.length - this.maxBufferSize);
    }
    this.buffers.set(key, buffer);
  }
}
