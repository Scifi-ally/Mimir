import { describe, expect, it } from "vitest";
import { isLiveModeActive, placeLiveOrder } from "../src/trading/broker_orders";

describe("Paper-only broker placement boundary", () => {
  it("refuses placement before checking credentials, database state, or network", async () => {
    expect(isLiveModeActive()).toBe(false);

    const result = await placeLiveOrder({
      suggestionId: "sug-abc-12345",
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
    });

    expect(result.ok).toBe(false);
    expect(result.liveOrderId).toBe("");
    expect(result.error).toContain("LIVE");
  });
});
