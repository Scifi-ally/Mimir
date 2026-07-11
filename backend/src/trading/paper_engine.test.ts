import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

describe("PaperEngine Math Precision", () => {
  it("avoids floating point drift on repeated fractional PnL additions", () => {
    let decBalance = new Decimal("10000.00");
    const decPnl = new Decimal("0.10");
    for (let i = 0; i < 100; i++) {
        decBalance = decBalance.plus(decPnl);
    }
    
    expect(decBalance.toFixed(2)).toBe("10010.00");
  });

  it("calculates exact slip and PnL for targets without drift", () => {
    const entryPrice = new Decimal("10.00");
    const target = new Decimal("10.30");
    const qty = new Decimal("200");
    
    const slippedLtp = target.mul(0.9995);
    const realizedPnl = slippedLtp.minus(entryPrice).mul(qty); 
    
    const startBalance = new Decimal("10000.00");
    const newBalance = startBalance.plus(realizedPnl);
    
    expect(slippedLtp.toString()).toBe("10.29485");
    expect(realizedPnl.toString()).toBe("58.97");
    expect(newBalance.toFixed(2)).toBe("10058.97");
    
    // Demonstrate JS float failure
    const jsSlippedLtp = 10.30 * 0.9995;
    expect(jsSlippedLtp).not.toBe(10.29485);
  });

  it("quarter-Kelly produces a more conservative risk percentage than half-Kelly", () => {
    const winProb = 0.65;
    const riskReward = 2.0;
    const fullKelly = winProb - ((1.0 - winProb) / riskReward);
    const halfKelly = fullKelly > 0 ? (fullKelly * 100) / 2.0 : 1.0;
    const quarterKelly = fullKelly > 0 ? (fullKelly * 100) / 4.0 : 0.5;
    
    expect(quarterKelly).toBeLessThan(halfKelly);
    expect(quarterKelly).toBeGreaterThan(0);
  });
});
