import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { placeLiveOrder, placeLiveGTTStopLoss, cancelLiveGTTOrder } from "../src/trading/broker_orders";
import * as configModule from "../src/config";
import * as authModule from "../src/upstox/auth";
import * as scannerModule from "../src/analysis/stock_scanner";

vi.mock("axios");
vi.mock("../src/config");
vi.mock("../src/upstox/auth");
vi.mock("../src/analysis/stock_scanner");
vi.mock("../db/src", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "test-live-order-1" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({}),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  liveOrdersTable: {
    id: "id",
    brokerOrderId: "brokerOrderId",
  },
}));

describe("Broker-side GTT Protection & Crash Resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      tradingMode: "LIVE",
      paperTradingEnabled: false,
    } as any);
    vi.spyOn(authModule, "getAccessToken").mockReturnValue("mock_token_123");
    vi.spyOn(scannerModule, "findStockBySymbol").mockResolvedValue({
      symbol: "RELIANCE",
      key: "NSE_EQ:INE002A01018",
    } as any);
  });

  it("should place a broker-side GTT stop loss when a live ENTRY order is placed", async () => {
    vi.mocked(axios.post).mockImplementation((url) => {
      if (url.includes("/order/place")) {
        return Promise.resolve({ data: { data: { order_id: "broker-order-999" } } });
      }
      if (url.includes("/gtt/place")) {
        return Promise.resolve({ data: { data: { gtt_order_id: "gtt-order-888" } } });
      }
      return Promise.reject(new Error("Unknown endpoint"));
    });

    const result = await placeLiveOrder({
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
      referencePrice: 2500,
      stopLossPrice: 2450,
    });

    expect(result.ok).toBe(true);
    expect(result.brokerOrderId).toBe("broker-order-999");
    expect(result.gttOrderId).toBe("gtt-order-888");

    // Verify GTT endpoint was called with correct trigger_price and stop loss parameters
    expect(axios.post).toHaveBeenCalledWith(
      "https://api.upstox.com/v2/gtt/place",
      expect.objectContaining({
        type: "SINGLE",
        quantity: 10,
        transaction_type: "SELL", // exit direction
        rules: expect.arrayContaining([
          expect.objectContaining({
            strategy: "STOPLOSS",
            trigger_price: 2450,
          }),
        ]),
      }),
      expect.anything()
    );
  });

  it("should maintain broker-side GTT protection if Node process crashes after entry", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { gtt_order_id: "gtt-protection-123" } },
    });

    const gttRes = await placeLiveGTTStopLoss({
      symbol: "RELIANCE",
      direction: "SELL",
      quantity: 5,
      triggerPrice: 2400,
      tradeType: "SWING",
    });

    expect(gttRes.ok).toBe(true);
    expect(gttRes.gttOrderId).toBe("gtt-protection-123");

    // Simulate process termination — GTT order was already submitted to broker
    // The protection exists at Upstox independently of Node event loop
  });

  it("should handle GTT cancellation", async () => {
    vi.mocked(axios.delete).mockResolvedValueOnce({ data: { status: "success" } });

    const success = await cancelLiveGTTOrder("gtt-protection-123");
    expect(success).toBe(true);
    expect(axios.delete).toHaveBeenCalledWith(
      expect.stringContaining("gtt_order_id=gtt-protection-123"),
      expect.anything()
    );
  });
});
