import { describe, it, expect } from "vitest";
import { computeQuotePressure } from "./tick_feeder";

/**
 * computeQuotePressure feeds `upstox:features:<symbol>`, which is what
 * decides whether the ranker is armed at all. signal_generator.ts sets
 * rankerIncomplete = true whenever that Redis key is missing or stale, and
 * rankerIncomplete = true means ranker_features: null, which silently
 * disarms the only calibrated model in the system.
 *
 * The critical property is the null case: "no quote" must be distinguishable
 * from "perfectly balanced". Returning 0 for a missing quote is what let a
 * broken feed look like a neutral reading.
 */
describe("computeQuotePressure", () => {
  it("returns +1 when the trade prints at the offer", () => {
    expect(computeQuotePressure(102, 100, 102)).toBeCloseTo(1, 6);
  });

  it("returns -1 when the trade prints at the bid", () => {
    expect(computeQuotePressure(100, 100, 102)).toBeCloseTo(-1, 6);
  });

  it("returns 0 when the trade prints at the mid", () => {
    expect(computeQuotePressure(101, 100, 102)).toBe(0);
  });

  it("scales linearly through the spread", () => {
    // A quarter of the way up a 2-wide spread -> position 0.25 -> -0.5.
    expect(computeQuotePressure(100.5, 100, 102)).toBeCloseTo(-0.5, 6);
    // Three quarters of the way up -> position 0.75 -> +0.5.
    expect(computeQuotePressure(101.5, 100, 102)).toBeCloseTo(0.5, 6);
  });

  it("stays within [-1, 1] when the trade prints outside the quoted spread", () => {
    // A gapping print can land beyond bid or ask; the result must not escape
    // the range or it would dominate a model that was trained on bounded input.
    expect(computeQuotePressure(500, 100, 102)).toBe(1);
    expect(computeQuotePressure(1, 100, 102)).toBe(-1);
  });

  it("returns null - not 0 - when there is no usable quote", () => {
    // This is the whole point of the function. Each of these must be
    // distinguishable from a genuinely balanced book.
    expect(computeQuotePressure(101, null, 102)).toBeNull();
    expect(computeQuotePressure(101, 100, null)).toBeNull();
    expect(computeQuotePressure(101, null, null)).toBeNull();
  });

  it("returns null for a zero or non-positive quote rather than dividing by it", () => {
    // paper_engine treats bid === 0 as "no liquidity"; a 0 here must not be
    // allowed to masquerade as a real spread.
    expect(computeQuotePressure(101, 0, 102)).toBeNull();
    expect(computeQuotePressure(101, 100, 0)).toBeNull();
    expect(computeQuotePressure(101, -1, 102)).toBeNull();
  });

  it("returns null for a crossed or degenerate spread", () => {
    expect(computeQuotePressure(101, 102, 100)).toBeNull(); // ask below bid
    expect(computeQuotePressure(101, 101, 101)).toBeNull(); // zero width
  });

  it("returns null for non-finite input instead of leaking NaN", () => {
    expect(computeQuotePressure(NaN, 100, 102)).toBeNull();
    expect(computeQuotePressure(101, NaN, 102)).toBeNull();
    expect(computeQuotePressure(101, 100, Infinity)).toBeNull();
    expect(computeQuotePressure(0, 100, 102)).toBeNull();
  });

  it("works on a realistic Indian-equity tick size", () => {
    // 5 paise spread on a ~1400 rupee stock is a tight but real quote.
    const pressure = computeQuotePressure(1400.15, 1400.1, 1400.15);
    expect(pressure).not.toBeNull();
    expect(pressure!).toBeGreaterThan(0.9);
  });
});
