import { describe, it, expect } from "vitest";
import { cashDeliveryCosts, cashIntradayCosts, isDeliveryTrade } from "./transaction_costs";
describe("Indian cash equity execution costs", () => {
  it("charges delivery STT on both legs and DP on selling", () => {
    // INR100,000 each side; statutory components and standard brokerage.
    expect(cashDeliveryCosts(100, 100, 1000)).toBeCloseTo(293.281436, 5);
    expect(cashIntradayCosts(100, 100, 1000)).toBeCloseTo(82.681436, 5);
  });
  it("does not mistake a swing breakout setup name for intraday", () => {
    expect(isDeliveryTrade("SWING", "MOMENTUM_CONTINUATION")).toBe(true);
    expect(isDeliveryTrade("INTRADAY", "SWING_RESEARCH")).toBe(false);
  });
  it("rejects impossible share quantities", () => {
    expect(() => cashDeliveryCosts(100, 101, .5)).toThrow();
    expect(() => cashIntradayCosts(100, 101, -1)).toThrow();
  });
});
