import { describe, it, expect } from "vitest";

/**
 * R-multiple excursions, re-implemented here to pin the arithmetic independently
 * of the tracker's internals.
 *
 * Getting direction wrong is the failure this guards: treating a short that ran
 * away from its entry as maximum *favourable* excursion would feed inverted
 * training data into every downstream average, silently and without an error.
 */
function excursionInR(
  direction: string,
  entry: number,
  stop: number,
  highest: number,
  lowest: number,
): { mfeR: number; maeR: number } {
  const risk = Math.abs(entry - stop);
  const isBuy = direction.toUpperCase() !== "SELL";
  // favourable >= 0 and adverse <= 0 before clamping. On a long, adverse must be
  // "low - entry": writing "entry - low" makes it positive and the clamp then
  // discards every adverse excursion.
  const favourable = isBuy ? highest - entry : entry - lowest;
  const adverse = isBuy ? lowest - entry : entry - highest;
  return {
    mfeR: Math.round((Math.max(0, favourable) / risk) * 1000) / 1000,
    maeR: Math.round((Math.min(0, adverse) / risk) * 1000) / 1000,
  };
}

describe("excursion in R-multiples", () => {
  // Entry 100, stop 95 => risk = 5.
  it("scores a long's move up as favourable and its move down as adverse", () => {
    const { mfeR, maeR } = excursionInR("BUY", 100, 95, 110, 96);
    expect(mfeR).toBe(2); // +10 over a 5 risk
    expect(maeR).toBe(-0.8); // -4 under
  });

  it("inverts for a short: the low is favourable, the high adverse", () => {
    const { mfeR, maeR } = excursionInR("SELL", 100, 105, 104, 90);
    expect(mfeR).toBe(2); // fell 10, risk 5
    expect(maeR).toBe(-0.8); // rose 4 against
  });

  it("is symmetric: a short mirrors a long across the entry", () => {
    const long = excursionInR("BUY", 100, 95, 110, 90);
    const short = excursionInR("SELL", 100, 105, 110, 90);
    expect(short.mfeR).toBe(long.mfeR);
    expect(short.maeR).toBe(long.maeR);
  });

  it("clamps a zero excursion rather than reporting a tiny negative", () => {
    // A bar that never moved should read as 0R, not -0.0 or a rounding artefact.
    const { mfeR } = excursionInR("BUY", 100, 95, 100, 100);
    expect(mfeR).toBe(0);
  });

  it("reports a full 1R adverse move for a stop exactly at the stop", () => {
    const { maeR, mfeR } = excursionInR("BUY", 100, 95, 101, 95);
    expect(maeR).toBe(-1);
    expect(mfeR).toBe(0.2);
  });

  it("is comparable across price scales, which is the point of R-multiples", () => {
    // Same 2R favourable move on a Rs 20 stock and a Rs 2000 stock must score
    // identically. A percentage excursion would report 50% vs 1%.
    const cheap = excursionInR("BUY", 20, 19, 22, 19.5);
    const dear = excursionInR("BUY", 2000, 1900, 2200, 1950);
    expect(cheap.mfeR).toBe(2);
    expect(dear.mfeR).toBe(2);
  });

  it("treats any non-SELL direction as a long", () => {
    // Defensive: an unexpected value must not silently become a short.
    expect(excursionInR("BUY", 100, 95, 110, 96).mfeR).toBe(
      excursionInR("SOMETHING_ELSE", 100, 95, 110, 96).mfeR,
    );
  });
});