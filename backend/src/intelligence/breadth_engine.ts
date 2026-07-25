import type { BreadthSnapshot, MarketState } from "./types";

export class MarketBreadthEngine {
  private snapshot: BreadthSnapshot | null = null;

  update(states: MarketState[]): BreadthSnapshot {
    let advancers = 0;
    let decliners = 0;
    let newHighs = 0;
    let newLows = 0;
    const sectorBuckets = new Map<string, { total: number; count: number }>();

    for (const state of states) {
      if (state.percentageChange > 0) advancers += 1;
      if (state.percentageChange < 0) decliners += 1;
      if (state.ltp >= state.high) newHighs += 1;
      if (state.ltp <= state.low) newLows += 1;
      const sector = state.sector ?? "Other";
      const bucket = sectorBuckets.get(sector) ?? { total: 0, count: 0 };
      bucket.total += state.percentageChange;
      bucket.count += 1;
      sectorBuckets.set(sector, bucket);
    }

    const breadthRatio = states.length ? (advancers - decliners) / states.length : 0;
    const regime =
      breadthRatio > 0.35
        ? "Risk-On"
        : breadthRatio > 0.12
          ? "Bullish"
          : breadthRatio < -0.35
            ? "Risk-Off"
            : breadthRatio < -0.12
              ? "Bearish"
              : newHighs + newLows > states.length * 0.2
                ? "Trending"
                : "Ranging";

    this.snapshot = {
      advancers,
      decliners,
      newHighs,
      newLows,
      sectorStrength: Object.fromEntries(
        [...sectorBuckets.entries()].map(([sector, bucket]) => [
          sector,
          Number((bucket.total / Math.max(1, bucket.count)).toFixed(2)),
        ]),
      ),
      regime,
      updatedAt: Date.now(),
    };
    return this.snapshot;
  }

  getSnapshot(): BreadthSnapshot | null {
    return this.snapshot;
  }
}
