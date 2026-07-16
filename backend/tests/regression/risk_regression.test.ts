import { describe, it, expect } from "vitest";
import { assessRisk } from "../../src/analysis/risk_engine";
import { getConfig } from "../../src/config";

describe("Risk Engine Regression", () => {
  it("should assess risk correctly for a simple mock setup", async () => {
    // We will provide stubs and mock setups to assessRisk
    // This ensures risk boundaries (capital limits, position limits, RR) remain structurally the same.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSetup: any = {
      direction: "BUY",
      entryPrice: 100,
      stopLoss: 98,
      target1: 104,
      target2: 108,
      riskReward: 2.0,
      score: 85,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSnapshot: any = {
      close: 100,
      ema20: 95,
      volumeRatio: 1.5,
      rsi14: 60,
      adx14: 25,
      atr14: 5,
      avgDailyVolume: 1000000,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockStock = { symbol: "TEST" } as any;

    const result = await assessRisk(mockSetup, mockSnapshot, "TECH", mockStock);

    // Derive expectations from live config instead of hardcoding capital:
    // risk per share = entry - stop = 2 INR; max risk = capital * riskPct;
    // position value is additionally capped at 20% of capital (risk_engine.ts).
    const cfg = getConfig();
    const riskPerShare = 2;
    const maxRiskInr = cfg.tradingCapital * ((cfg.maxRiskPerTradePct ?? 2) / 100);
    const baseQty = Math.floor(maxRiskInr / riskPerShare);
    const positionCapQty = Math.floor((cfg.tradingCapital * 0.20) / mockSetup.entryPrice);
    const expectedQty = Math.min(baseQty, positionCapQty);

    console.log("Risk Assessment Rejections:", result.rejectionReasons);
    console.log("Risk Assessment Warnings:", result.warningReasons);
    expect(result.positionSize).toBe(expectedQty);
    expect(result.investmentAmount).toBe(expectedQty * mockSetup.entryPrice);
    expect(result.riskReward).toBeCloseTo(2.0, 1);
  });
});
