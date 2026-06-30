import { describe, it, expect } from "vitest";
import {
  detectBreakoutConfirmation,
  detectPullbackComplete,
  detectMomentumContinuation,
} from "./intraday_monitor";

describe("Intraday Monitor Pattern Detectors", () => {
  describe("detectBreakoutConfirmation", () => {
    it("should return false if there are less than 5 ticks", () => {
      const ticks = [{ price: 100, volume: 10 }];
      expect(detectBreakoutConfirmation(ticks, "BUY")).toBe(false);
    });

    it("should confirm BUY breakout when last price is above midpoint of last 5 ticks and volume > 0", () => {
      const ticks = [
        { price: 100, volume: 10 },
        { price: 102, volume: 10 },
        { price: 104, volume: 10 },
        { price: 106, volume: 10 },
        { price: 108, volume: 10 }, // Midpoint is 104, last is 108 (> 104)
      ];
      expect(detectBreakoutConfirmation(ticks, "BUY")).toBe(true);
    });

    it("should not confirm BUY breakout if last price is at or below midpoint of last 5 ticks", () => {
      const ticks = [
        { price: 108, volume: 10 },
        { price: 106, volume: 10 },
        { price: 104, volume: 10 },
        { price: 102, volume: 10 },
        { price: 100, volume: 10 }, // Midpoint is 104, last is 100 (<= 104)
      ];
      expect(detectBreakoutConfirmation(ticks, "BUY")).toBe(false);
    });

    it("should confirm SELL breakout when last price is below midpoint of last 5 ticks and volume > 0", () => {
      const ticks = [
        { price: 108, volume: 10 },
        { price: 106, volume: 10 },
        { price: 104, volume: 10 },
        { price: 102, volume: 10 },
        { price: 100, volume: 10 }, // Midpoint is 104, last is 100 (< 104)
      ];
      expect(detectBreakoutConfirmation(ticks, "SELL")).toBe(true);
    });
  });

  describe("detectPullbackComplete", () => {
    it("should return false if there are less than 8 ticks", () => {
      const ticks = Array(7).fill({ price: 100, volume: 10 });
      expect(detectPullbackComplete(ticks, "BUY")).toBe(false);
    });

    it("should confirm BUY pullback when initialTrend < pullback < recovery", () => {
      // initialTrend (0-3 avg), pullback (3-6 avg), recovery (6+ avg)
      const ticks = [
        { price: 100, volume: 10 }, // initialTrend avg = 100
        { price: 100, volume: 10 },
        { price: 100, volume: 10 },
        { price: 105, volume: 10 }, // pullback avg = 105
        { price: 105, volume: 10 },
        { price: 105, volume: 10 },
        { price: 110, volume: 10 }, // recovery avg = 110
        { price: 110, volume: 10 },
      ];
      expect(detectPullbackComplete(ticks, "BUY")).toBe(true);
    });

    it("should confirm SELL pullback when initialTrend > pullback > recovery", () => {
      const ticks = [
        { price: 110, volume: 10 }, // initialTrend avg = 110
        { price: 110, volume: 10 },
        { price: 110, volume: 10 },
        { price: 105, volume: 10 }, // pullback avg = 105
        { price: 105, volume: 10 },
        { price: 105, volume: 10 },
        { price: 100, volume: 10 }, // recovery avg = 100
        { price: 100, volume: 10 },
      ];
      expect(detectPullbackComplete(ticks, "SELL")).toBe(true);
    });
  });

  describe("detectMomentumContinuation", () => {
    it("should return false if there are less than 4 ticks", () => {
      const ticks = Array(3).fill({ price: 100, volume: 10 });
      expect(detectMomentumContinuation(ticks, "BUY")).toBe(false);
    });

    it("should confirm BUY momentum if last 3 changes are positive", () => {
      const ticks = [
        { price: 100, volume: 10 },
        { price: 101, volume: 10 }, // trend3: 101 - 100 = 1 > 0
        { price: 102, volume: 10 }, // trend2: 102 - 101 = 1 > 0
        { price: 103, volume: 10 }, // trend1: 103 - 102 = 1 > 0
      ];
      expect(detectMomentumContinuation(ticks, "BUY")).toBe(true);
    });

    it("should confirm SELL momentum if last 3 changes are negative", () => {
      const ticks = [
        { price: 103, volume: 10 },
        { price: 102, volume: 10 }, // trend3: 102 - 103 = -1 < 0
        { price: 101, volume: 10 }, // trend2: 101 - 102 = -1 < 0
        { price: 100, volume: 10 }, // trend1: 100 - 101 = -1 < 0
      ];
      expect(detectMomentumContinuation(ticks, "SELL")).toBe(true);
    });
  });
});
