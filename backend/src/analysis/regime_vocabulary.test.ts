/**
 * Regression tests for the breadth-regime vocabulary mismatch.
 *
 * The system compared `MarketBreadthEngine`'s output
 * ("Risk-On" | "Bullish" | "Risk-Off" | "Bearish" | "Trending" | "Ranging")
 * against tokens from a different taxonomy
 * ("TRENDING_DOWN" | "BEARISH" | "TRENDING_UP" | "BULLISH")
 * using exact string equality, on a value forwarded verbatim by
 * `orchestrator.ts`. "Bearish" !== "BEARISH" on case alone, and the two
 * EXTREME regimes had no matching token at all — so the counter-trend penalty
 * was dead code and long entries in a risk-off tape were never penalised.
 */

import { describe, it, expect } from "vitest";
import {
  classifyBreadthRegime,
  counterTrendPenalty,
  isCounterTrend,
} from "./regime_vocabulary";

describe("classifyBreadthRegime", () => {
  it("recognizes every label the breadth engine actually emits", () => {
    // breadth_engine.ts:26-37
    expect(classifyBreadthRegime("Risk-On")).toBe("risk_on");
    expect(classifyBreadthRegime("Bullish")).toBe("bullish");
    expect(classifyBreadthRegime("Risk-Off")).toBe("risk_off");
    expect(classifyBreadthRegime("Bearish")).toBe("bearish");
    expect(classifyBreadthRegime("Trending")).toBe("neutral");
    expect(classifyBreadthRegime("Ranging")).toBe("neutral");
  });

  it("is case and separator insensitive", () => {
    for (const v of ["BEARISH", "bearish", "Bearish", "bEaRiSh"]) {
      expect(classifyBreadthRegime(v)).toBe("bearish");
    }
    for (const v of ["RISK-ON", "risk_on", "Risk-On", "RISK ON"]) {
      expect(classifyBreadthRegime(v)).toBe("risk_on");
    }
  });

  it("still understands the legacy taxonomy from cached rows", () => {
    expect(classifyBreadthRegime("TRENDING_DOWN")).toBe("bearish");
    expect(classifyBreadthRegime("TRENDING_UP")).toBe("bullish");
    expect(classifyBreadthRegime("BEARISH_CONTRACTION")).toBe("bearish");
    expect(classifyBreadthRegime("BULLISH_EXPANSION")).toBe("bullish");
  });

  it("treats unknown or missing data as neutral rather than guessing", () => {
    for (const v of [undefined, null, "", "   ", "UNKNOWN", "N/A", 42, {}]) {
      expect(classifyBreadthRegime(v)).toBe("neutral");
    }
  });
});

describe("counter-trend detection", () => {
  it("penalizes longs in a falling tape, including the extremes", () => {
    for (const regime of ["Risk-Off", "Bearish", "TRENDING_DOWN", "BEARISH_CONTRACTION"]) {
      expect(isCounterTrend(classifyBreadthRegime(regime), "BUY")).toBe(true);
      expect(isCounterTrend(classifyBreadthRegime(regime), "SELL")).toBe(false);
    }
  });

  it("penalizes shorts in a rising tape, including the extremes", () => {
    for (const regime of ["Risk-On", "Bullish", "TRENDING_UP", "BULLISH_EXPANSION"]) {
      expect(isCounterTrend(classifyBreadthRegime(regime), "SELL")).toBe(true);
      expect(isCounterTrend(classifyBreadthRegime(regime), "BUY")).toBe(false);
    }
  });

  it("does not penalize with-regime trades or in neutral regimes", () => {
    expect(isCounterTrend("bullish", "BUY")).toBe(false);
    expect(isCounterTrend("bearish", "SELL")).toBe(false);
    expect(isCounterTrend("neutral", "BUY")).toBe(false);
    expect(isCounterTrend("neutral", "SELL")).toBe(false);
  });

  it("defaults a missing direction to BUY, matching the existing convention", () => {
    expect(isCounterTrend("bearish", undefined)).toBe(true);
    expect(isCounterTrend("bullish", undefined)).toBe(false);
  });
});

describe("counterTrendPenalty", () => {
  it("penalizes the extreme regimes harder than the mild ones", () => {
    expect(counterTrendPenalty("risk_off")).toBeGreaterThan(counterTrendPenalty("bearish"));
    expect(counterTrendPenalty("risk_on")).toBeGreaterThan(counterTrendPenalty("bullish"));
  });

  it("is zero for neutral regimes", () => {
    expect(counterTrendPenalty("neutral")).toBe(0);
  });

  it("stays inside the 0-10 aiScore scale", () => {
    for (const b of ["risk_on", "bullish", "neutral", "bearish", "risk_off"] as const) {
      const p = counterTrendPenalty(b);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(10);
    }
  });
});

describe("the original bug", () => {
  it("would never have fired under exact string equality", () => {
    // Demonstrates the defect these tests exist to prevent: the old comparison
    // against "BEARISH" could not match the value the producer actually emits.
    // Typed as string so the comparison is evaluated at runtime rather than
    // being narrowed away by the compiler.
    const emitted: string = "Bearish";
    const oldBranchFired = emitted === "TRENDING_DOWN" || emitted === "BEARISH";
    expect(oldBranchFired).toBe(false);
    // The new mapping does fire.
    expect(counterTrendPenalty(classifyBreadthRegime(emitted))).toBeGreaterThan(0);
  });

  it("catches the two extreme regimes the old code had no token for", () => {
    for (const emitted of ["Risk-On", "Risk-Off"]) {
      const oldBranchFired =
        emitted === "TRENDING_DOWN" ||
        emitted === "BEARISH" ||
        emitted === "TRENDING_UP" ||
        emitted === "BULLISH";
      expect(oldBranchFired).toBe(false);
      expect(counterTrendPenalty(classifyBreadthRegime(emitted))).toBeGreaterThan(0);
    }
  });
});
