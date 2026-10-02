import { describe, expect, it } from "vitest";
import { matchedWindowAlpha, passesGapGuard, simulateLong, type Candle } from "./walk_forward_strategies_lib";

function candles(...bars: Array<Partial<Candle>>): Candle[] {
  return bars.map((bar, index) => ({ date: `2024-01-0${index + 1}`, open: 100, high: 101, low: 99, close: 100, volume: 1, ...bar }));
}

describe("walk-forward simulator", () => {
  it("exits at the open when a gap crosses the stop", () => {
    const trade = simulateLong(candles({}, { open: 90, low: 89 }), 0, 95, 110, 1, 0);
    expect(trade?.netPct).toBe(0);
  });

  it("checks stop before target in the same bar", () => {
    const trade = simulateLong(candles({}, { high: 110, low: 90 }), 0, 95, 105, 1, 0);
    expect(trade?.outcome).toBe("LOSS");
  });

  it("exits at the target", () => {
    const trade = simulateLong(candles({}, { high: 110 }), 0, 95, 105, 1, 0);
    expect(trade?.outcome).toBe("WIN");
    expect(trade?.netPct).toBeCloseTo(5);
  });

  it("times out at the final close", () => {
    const trade = simulateLong(candles({}, { close: 102 }, { close: 103 }), 0, 95, 110, 2, 0);
    expect(trade?.outcome).toBe("TIMEOUT");
    expect(trade?.netPct).toBeCloseTo(3);
  });

  it("rejects a gap above 1.5 percent", () => {
    expect(passesGapGuard(100, 101.51)).toBe(false);
  });
});

describe("matched-window alpha", () => {
  it("subtracts the compounded benchmark return from entry to exit", () => {
    expect(matchedWindowAlpha({ entryDate: "2024-01-01", exitDate: "2024-01-03", netPct: 10 }, new Map([
      ["2024-01-01", 1],
      ["2024-01-03", 1.04],
    ]))).toBeCloseTo(6);
  });
});
