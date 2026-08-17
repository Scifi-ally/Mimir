import axios from "axios";
import { describe, expect, it, vi } from "vitest";
import { placeLiveOrder } from "../src/trading/broker_orders";

describe("Signal-only broker integration boundary", () => {
  it("does not contact an Upstox order endpoint", async () => {
    const post = vi.spyOn(axios, "post");

    const result = await placeLiveOrder({
      symbol: "TATASTEEL",
      direction: "BUY",
      quantity: 50,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
      referencePrice: 150,
    });

    expect(result.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });
});
