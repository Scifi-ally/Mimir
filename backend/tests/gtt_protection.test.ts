import { describe, expect, it } from "vitest";
import {
  cancelLiveGTTOrder,
  isLiveModeActive,
  placeLiveGTTStopLoss,
  placeLiveOrder,
} from "../src/trading/broker_orders";

describe("Paper-only broker boundary", () => {
  it("does not expose live mode even when configuration is stale", () => {
    expect(isLiveModeActive()).toBe(false);
  });

  it("refuses broker order and GTT placement", async () => {
    const order = await placeLiveOrder({
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
      referencePrice: 2500,
      stopLossPrice: 2450,
    });
    expect(order.ok).toBe(false);
    expect(order.error).toContain("LIVE");

    const gtt = await placeLiveGTTStopLoss({
      symbol: "RELIANCE",
      direction: "SELL",
      quantity: 5,
      triggerPrice: 2400,
      tradeType: "SWING",
    });
    expect(gtt.ok).toBe(false);
    expect(gtt.error).toContain("LIVE");
  });

  it("refuses broker-side GTT cancellation", async () => {
    await expect(cancelLiveGTTOrder("gtt-protection-123")).resolves.toBe(false);
  });
});
