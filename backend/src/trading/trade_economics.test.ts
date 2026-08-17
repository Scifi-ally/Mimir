import { describe, expect, it } from "vitest";
import { calculateNetPnl, computeSafeQuantity } from "./trade_economics";

describe("trade economics", () => {
  it("rejects a trade when one unit exceeds the risk budget", () => {
    const result = computeSafeQuantity({
      capital: 10_000,
      riskPct: 1,
      entryPrice: 1_000,
      stopLoss: 800,
      direction: "BUY",
    });

    expect(result.rejected).toBe(true);
    expect(result.quantity).toBe(0);
    expect(result.actualRiskInr).toBe(0);
  });

  it("never exceeds the requested risk budget when sized", () => {
    const result = computeSafeQuantity({
      capital: 100_000,
      riskPct: 1,
      entryPrice: 100,
      stopLoss: 98,
      direction: "BUY",
    });

    expect(result.rejected).toBe(false);
    expect(result.quantity).toBe(200);
    expect(result.actualRiskInr).toBeLessThanOrEqual(1_000);
  });

  it("uses the same explicit brokerage and sell-side STT model for long and short trades", () => {
    const long = calculateNetPnl({
      entryPrice: 100,
      exitPrice: 110,
      quantity: 10,
      direction: "BUY",
      brokeragePerOrderInr: 20,
    });
    const short = calculateNetPnl({
      entryPrice: 110,
      exitPrice: 100,
      quantity: 10,
      direction: "SELL",
      brokeragePerOrderInr: 20,
    });

    expect(long.grossPnl).toBe(100);
    expect(short.grossPnl).toBe(100);
    expect(long.totalCharges).toBeGreaterThan(40);
    expect(short.totalCharges).toBeGreaterThan(40);
    expect(long.netPnl).toBeLessThan(long.grossPnl);
    expect(short.netPnl).toBeLessThan(short.grossPnl);
  });
});
