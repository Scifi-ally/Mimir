import { describe, it, expect } from "vitest";
import { diagnosticPnl, summarizeOutcomeEvidence } from "./outcome_evidence";

describe("outcome evidence", () => {
  it("does not invent a 50 percent baseline for small samples", () => {
    expect(summarizeOutcomeEvidence([100, 100, 100]).winRatePct).toBeNull();
  });
  it("includes measured timeout losses and zero outcomes in the denominator", () => {
    const evidence = summarizeOutcomeEvidence([...Array(10).fill(100), ...Array(10).fill(-300), ...Array(10).fill(0)]);
    expect(evidence.winRatePct).toBeCloseTo(100 / 3);
    expect(evidence.meanPnl).toBeLessThan(0);
    expect(evidence.lowerMean95).toBeLessThan(evidence.meanPnl!);
  });
  it("distinguishes unavailable PnL from a measured zero", () => {
    expect(diagnosticPnl(null)).toBeNull();
    expect(diagnosticPnl("")).toBeNull();
    expect(diagnosticPnl("0.00")).toBe(0);
    expect(diagnosticPnl("bad")).toBeNull();
  });
});
