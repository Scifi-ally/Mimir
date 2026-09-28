/**
 * Regression tests for the paper engine's position-sizing contract.
 *
 * Background: `paper_engine` used to re-derive the order size from a 0-100
 * `confidence` score, ignoring the risk engine's `maxRiskInr` and `quantity`
 * even though both were already persisted on the suggestion row. Every control
 * computed upstream — macro-risk halving, 20%-of-capital cap, 90%
 * deployed-capital cap, quarter-Kelly — was therefore discarded at the final
 * step, on all three decision paths.
 */

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { resolveOrderQuantity } from "./paper_engine";

const BALANCE = new Decimal(10000);
const STOP = new Decimal(5); // ₹5/share risk

describe("resolveOrderQuantity honours the upstream risk decision", () => {
  it("clamps the locally derived risk to the risk engine's maxRiskInr", () => {
    // 1.5% of 10,000 = ₹150, but the risk engine only approved ₹50.
    const unconstrained = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 1.5,
      stopDistance: STOP,
    });
    expect(unconstrained.riskAmount.toNumber()).toBe(150);
    expect(unconstrained.quantity).toBe(30);

    const constrained = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 1.5,
      stopDistance: STOP,
      upstreamMaxRiskInr: new Decimal(50),
    });
    expect(constrained.cappedByUpstream).toBe(true);
    expect(constrained.riskAmount.toNumber()).toBe(50);
    // 50 / 5 = 10 shares, not 30.
    expect(constrained.quantity).toBe(10);
  });

  it("never exceeds the share count the risk engine approved", () => {
    const sized = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 1.5,
      stopDistance: STOP,
      upstreamQuantity: 4,
    });
    expect(sized.quantity).toBe(4);
  });

  it("does not inflate a position when the risk engine approved more", () => {
    // A loose upstream quantity must not become a licence to size up; the risk
    // budget still binds.
    const sized = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 1.0,
      stopDistance: STOP,
      upstreamQuantity: 10_000,
    });
    expect(sized.quantity).toBe(20); // 100 / 5
  });

  it("declines rather than forcing a 1-share trade the budget cannot cover", () => {
    // Risk budget ₹20 with a ₹50 stop distance: cannot afford one share.
    // The old `Decimal.max(1, ...)` forced 1 share, risking ₹50 — 2.5x the
    // entire budget, on exactly the setups the risk engine had sized down.
    const sized = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 0.2, // ₹20
      stopDistance: new Decimal(50),
    });
    expect(sized.quantity).toBe(0);
  });

  it("treats the tightest of risk cap and share cap as binding", () => {
    // Risk cap implies 10 shares, share cap allows 6 -> 6.
    const byRisk = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 1.5,
      stopDistance: STOP,
      upstreamMaxRiskInr: new Decimal(50),
      upstreamQuantity: 6,
    });
    expect(byRisk.quantity).toBe(6);

    // Share cap allows 6, risk budget only affords 2 -> 2.
    const byBudget = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 0.1, // ₹10 => 2 shares
      stopDistance: STOP,
      upstreamQuantity: 6,
    });
    expect(byBudget.quantity).toBe(2);
  });

  it("still works when no upstream risk decision exists (realtime/intraday paths)", () => {
    // Those paths never call assessRisk, so the cap must be optional and sizing
    // must fall back to the local risk budget.
    const sized = resolveOrderQuantity({
      balance: BALANCE,
      riskPct: 1.0,
      stopDistance: STOP,
      upstreamMaxRiskInr: null,
      upstreamQuantity: null,
    });
    expect(sized.quantity).toBe(20);
    expect(sized.cappedByUpstream).toBe(false);
  });

  it("ignores a nonsensical upstream cap rather than zeroing the trade", () => {
    for (const bad of [new Decimal(0), new Decimal(-10), new Decimal(NaN)]) {
      const sized = resolveOrderQuantity({
        balance: BALANCE,
        riskPct: 1.0,
        stopDistance: STOP,
        upstreamMaxRiskInr: bad,
        upstreamQuantity: 0,
      });
      expect(sized.quantity).toBe(20);
    }
  });

  it("returns zero for a zero or NaN stop distance instead of dividing by zero", () => {
    expect(
      resolveOrderQuantity({ balance: BALANCE, riskPct: 1.0, stopDistance: new Decimal(0) }).quantity,
    ).toBe(0);
    expect(
      resolveOrderQuantity({ balance: BALANCE, riskPct: 1.0, stopDistance: new Decimal(NaN) }).quantity,
    ).toBe(0);
  });

  it("keeps arithmetic exact — no floating point drift on fractional rupees", () => {
    // 0.1% of 33,333.33 is ₹33.33333; repeated float math would drift.
    const sized = resolveOrderQuantity({
      balance: new Decimal(33333.33),
      riskPct: 0.1,
      stopDistance: new Decimal(3.33),
      upstreamMaxRiskInr: new Decimal(33.33),
    });
    expect(sized.cappedByUpstream).toBe(true);
    expect(sized.riskAmount.toString()).toBe("33.33");
    expect(sized.quantity).toBe(10);
  });
});
