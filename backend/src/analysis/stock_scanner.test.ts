import { describe, it, expect } from "vitest";
import { applyScoringWeights } from "./stock_scanner";

describe("Scoring Engine - applyScoringWeights", () => {
  it("should cap the maximum score at 10.0 even with all strong boosts", () => {
    const baseScore = 8.0;
    const finalScore = applyScoringWeights(
      baseScore,
      "BUY",
      true, // hasStrongHigherTfContext
      1.5, // rs60 (strong > 1.1)
      "confirms", // htfConf
      { direction: "BUY", confluenceScore: 90, crossover1h: true, crossover4h: true, volumeIncrease: true } // mtfSignal
    );
    // base (8.0) + RS(0.4) + HTF(0.4) + MTF_STRONG(0.8) + MTF_CROSS(0.2) + MTF_VOL(0.2) = 10.0
    expect(finalScore).toBeLessThanOrEqual(10.0);
    expect(finalScore).toBe(10.0);
  });

  it("should clamp the minimum score to 0.0 with massive penalties", () => {
    const baseScore = 2.0;
    const finalScore = applyScoringWeights(
      baseScore,
      "BUY",
      false, // hasStrongHigherTfContext -> penalty
      0.8, // rs60 (weak < 0.9) -> penalty
      "contradicts", // htfConf -> penalty
      { direction: "SELL", confluenceScore: 80, crossover1h: false, crossover4h: false, volumeIncrease: false } // mtfSignal contradict -> penalty
    );
    expect(finalScore).toBeGreaterThanOrEqual(0.0);
    expect(finalScore).toBe(0.0);
  });

  it("should properly scale an average setup", () => {
    const baseScore = 6.0;
    const finalScore = applyScoringWeights(
      baseScore,
      "BUY",
      true, // hasStrongHigherTfContext
      1.0, // rs60 neutral
      "neutral", // htfConf neutral
      { direction: "BUY", confluenceScore: 55, crossover1h: false, crossover4h: false, volumeIncrease: false } // mtfSignal partial
    );
    // base(6.0) + partial MTF (0.4) = 6.4
    expect(finalScore).toBeCloseTo(6.4 + 0.0); // using math addition to prevent floating point drift if any
  });
});
