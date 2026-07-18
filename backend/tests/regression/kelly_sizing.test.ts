import { describe, it, expect } from "vitest";
import { fractionalKellyRiskPct } from "../../src/analysis/risk_engine";

describe("Fractional-Kelly risk sizing", () => {
  const MAX = 2.0; // configured per-trade risk ceiling (%)

  it("returns 0 when the edge is non-positive (model expects to lose)", () => {
    // p=0.4, b=1 → full Kelly = (0.4*1 - 0.6)/1 = -0.2 → clamp to 0
    expect(fractionalKellyRiskPct(0.4, 1.0, MAX)).toBe(0);
    // Exactly break-even (p=0.5, b=1) → 0
    expect(fractionalKellyRiskPct(0.5, 1.0, MAX)).toBe(0);
  });

  it("sizes proportionally to edge, as a quarter of full Kelly", () => {
    // p=0.6, b=2 → fullKelly = (0.6*2 - 0.4)/2 = 0.4 ; quarter = 0.1 → 10%,
    // but capped at MAX=2%.
    expect(fractionalKellyRiskPct(0.6, 2.0, MAX)).toBe(MAX);

    // A thin edge stays BELOW the cap so we can verify the quarter-Kelly math.
    // p=0.55, b=1.2 → fullKelly = (0.55*1.2 - 0.45)/1.2 = (0.66-0.45)/1.2 = 0.175
    // quarter = 0.04375 → 4.375%, still above 2% cap → capped.
    // Use an even thinner edge to land under the cap:
    // p=0.52, b=1.0 → fullKelly = (0.52 - 0.48)/1 = 0.04 ; quarter = 0.01 → 1.0%
    expect(fractionalKellyRiskPct(0.52, 1.0, MAX)).toBeCloseTo(1.0, 6);
  });

  it("never exceeds the configured max risk ceiling", () => {
    // Huge edge would recommend way more than the cap.
    expect(fractionalKellyRiskPct(0.9, 5.0, MAX)).toBe(MAX);
  });

  it("falls back to the flat max on degenerate inputs (graceful degradation)", () => {
    expect(fractionalKellyRiskPct(0, 2.0, MAX)).toBe(MAX);
    expect(fractionalKellyRiskPct(1, 2.0, MAX)).toBe(MAX);
    expect(fractionalKellyRiskPct(0.6, 0, MAX)).toBe(MAX);
  });
});
