import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeOFI } from "../src/analysis/order_flow";
import { tickDistribution, NormalizedTick } from "../src/market_data/tick_distribution";

describe("Order Flow Imbalance (OFI)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should calculate buy and sell volume correctly using tick rule", () => {
    const mockTicks: NormalizedTick[] = [
      { symbol: "TEST", ltp: 100, volume: 1000, bid: 99, ask: 101, timestamp: 1 },
      // Price up -> Buy Volume (vol diff: 500)
      { symbol: "TEST", ltp: 102, volume: 1500, bid: 101, ask: 103, timestamp: 2 },
      // Price down -> Sell Volume (vol diff: 300)
      { symbol: "TEST", ltp: 101, volume: 1800, bid: 100, ask: 102, timestamp: 3 },
      // Price same -> Use previous direction (Sell, vol diff: 200)
      { symbol: "TEST", ltp: 101, volume: 2000, bid: 100, ask: 102, timestamp: 4 },
      // Price up -> Buy Volume (vol diff: 1000)
      { symbol: "TEST", ltp: 105, volume: 3000, bid: 104, ask: 106, timestamp: 5 }
    ];

    vi.spyOn(tickDistribution, "getTickHistory").mockReturnValue(mockTicks);

    const result = computeOFI("TEST");

    // Buy volume: 500 (tick 2) + 1000 (tick 5) = 1500
    // Sell volume: 300 (tick 3) + 200 (tick 4) = 500
    // OFI = 1500 - 500 = 1000
    // Total Volume = 1500 + 500 = 2000
    // OFI Ratio = 1000 / 2000 = 0.5
    expect(result.buyVolume).toBe(1500);
    expect(result.sellVolume).toBe(500);
    expect(result.ofi).toBe(1000);
    expect(result.ofiRatio).toBe(0.5);
    expect(result.ticksEvaluated).toBe(5);
  });

  it("should return defaults if not enough ticks", () => {
    vi.spyOn(tickDistribution, "getTickHistory").mockReturnValue([]);
    const result = computeOFI("TEST");
    expect(result.ofiRatio).toBe(0);
    expect(result.ticksEvaluated).toBe(0);
  });
});
