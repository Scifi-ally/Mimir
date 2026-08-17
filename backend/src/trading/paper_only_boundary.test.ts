import { describe, expect, it } from "vitest";
import {
  cancelLiveGTTOrder,
  cancelLiveOrder,
  isLiveModeActive,
  placeLiveGTTStopLoss,
  placeLiveOrder,
} from "./broker_orders";

describe("paper-only broker boundary", () => {
  it("never reports live mode as active", () => {
    expect(isLiveModeActive()).toBe(false);
  });

  it("refuses live placement before reading credentials or calling the broker", async () => {
    const result = await placeLiveOrder({
      symbol: "NSE_EQ|INE002A01018",
      direction: "BUY",
      quantity: 1,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("LIVE");
  });

  it("refuses GTT placement and cancellation in paper-only mode", async () => {
    const placed = await placeLiveGTTStopLoss({
      symbol: "NSE_EQ|INE002A01018",
      direction: "SELL",
      quantity: 1,
      triggerPrice: 100,
      tradeType: "INTRADAY",
    });
    expect(placed.ok).toBe(false);

    await expect(cancelLiveGTTOrder("gtt-id")).resolves.toBe(false);
    await expect(cancelLiveOrder("order-id")).resolves.toBe(false);
  });
});
