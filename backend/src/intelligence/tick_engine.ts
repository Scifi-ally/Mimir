import type { MarketState, MarketTickEvent } from "./types";

export class TickEngine {
  private readonly states = new Map<string, MarketState>();

  applyTick(tick: MarketTickEvent): MarketState {
    const existing = this.states.get(tick.instrumentKey);
    const open = existing?.open ?? tick.ltp;
    const high = existing ? Math.max(existing.high, tick.ltp) : tick.ltp;
    const low = existing ? Math.min(existing.low, tick.ltp) : tick.ltp;
    const previousVolume = existing?.volume ?? 0;
    const volume = Math.max(tick.volume ?? 0, previousVolume);
    const state: MarketState = {
      instrumentKey: tick.instrumentKey,
      symbol: tick.symbol,
      ltp: tick.ltp,
      open,
      high,
      low,
      volume,
      previousVolume,
      percentageChange: open > 0 ? ((tick.ltp - open) / open) * 100 : 0,
      turnover: tick.ltp * volume,
      firstSeenAt: existing?.firstSeenAt ?? tick.timestamp,
      updatedAt: tick.timestamp,
      sector: existing?.sector,
    };
    this.states.set(tick.instrumentKey, state);
    return state;
  }

  setSector(instrumentKey: string, sector: MarketState["sector"]): void {
    const state = this.states.get(instrumentKey);
    if (state) this.states.set(instrumentKey, { ...state, sector });
  }

  getState(instrumentKey: string): MarketState | null {
    return this.states.get(instrumentKey) ?? null;
  }

  getAllStates(): MarketState[] {
    return Array.from(this.states.values());
  }

  size(): number {
    return this.states.size;
  }
}
