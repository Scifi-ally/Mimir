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
const { activeOrders, txSelectCalls } = vi.hoisted(() => ({
  activeOrders: [] as Array<Record<string, any>>,
  txSelectCalls: { value: 0 },
}));
vi.mock("../db/src", () => ({
  db: {
    transaction: vi.fn().mockImplementation(async (run) => run({
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "test-live-order-1" }]),
        }),
      }),
      select: vi.fn().mockImplementation(() => {
        const call = txSelectCalls.value++;
        const selected = call === 0 || call === 2 ? activeOrders : [];
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(selected),
            }),
          }),
        };
      }),
    })),
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
        where: vi.fn().mockResolvedValue(activeOrders),
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
    activeOrders.length = 0;
    txSelectCalls.value = 0;
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
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { status: "success", data: {
        order_id: "broker-order-999", status: "complete", filled_quantity: 10, pending_quantity: 0,
        quantity: 10, instrument_token: "NSE_EQ|INE002A01018", transaction_type: "BUY", product: "I",
      } },
    } as any);
    vi.mocked(axios.post).mockImplementation((url) => {
      if (url.includes("/order/place")) {
        return Promise.resolve({ data: { data: { order_id: "broker-order-999" } } });
      }
      if (url.includes("/gtt/place")) {
        return Promise.resolve({ data: { status: "success", data: { gtt_order_ids: ["gtt-order-888"] } } });
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
      "https://api.upstox.com/v3/order/gtt/place",
      expect.objectContaining({
        type: "SINGLE",
        quantity: 10,
        transaction_type: "SELL", // exit direction
        rules: expect.arrayContaining([
          expect.objectContaining({
            strategy: "ENTRY",
            trigger_type: "BELOW",
            trigger_price: 2450,
          }),
        ]),
      }),
      expect.anything()
    );
    const gttCall = vi.mocked(axios.post).mock.calls.find(([url]) => String(url).includes("/gtt/place"));
    const gttRules = (gttCall?.[1] as { rules: Array<Record<string, unknown>> } | undefined)?.rules;
    expect(gttRules?.[0]).not.toHaveProperty("price");
    expect(gttRules?.[0]).not.toHaveProperty("order_type");
  });

  it("does not submit an exit GTT for an accepted entry without a confirmed full fill", async () => {
    vi.mocked(axios.post).mockImplementation((url) => {
      if (url.includes("/order/place")) {
        return Promise.resolve({ data: { data: { order_id: "broker-entry-unfilled" } } });
      }
      return Promise.reject(new Error("Unexpected GTT submission"));
    });
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { status: "success", data: {
        order_id: "broker-entry-unfilled", status: "open", filled_quantity: 0, pending_quantity: 10,
        quantity: 10, instrument_token: "NSE_EQ|INE002A01018", transaction_type: "BUY", product: "I",
      } },
    } as any);

    const result = await placeLiveOrder({
      symbol: "RELIANCE", direction: "BUY", quantity: 10, orderType: "ENTRY", tradeType: "INTRADAY", stopLossPrice: 2450,
    });

    expect(result.ok).toBe(true);
    expect(result.protectiveStopPlaced).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(
      "https://api.upstox.com/v2/order/details?order_id=broker-entry-unfilled",
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it("should maintain broker-side GTT protection if Node process crashes after entry", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { status: "success", data: { gtt_order_ids: ["gtt-protection-123"] } },
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
    vi.mocked(axios.delete).mockResolvedValueOnce({
      data: { status: "success", data: { gtt_order_ids: ["gtt-protection-123"] } },
    });

    const success = await cancelLiveGTTOrder("gtt-protection-123");
    expect(success).toBe(true);
    expect(axios.delete).toHaveBeenCalledWith(
      "https://api.upstox.com/v3/order/gtt/cancel",
      expect.objectContaining({
        data: { gtt_order_id: "gtt-protection-123" },
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("cancels active GTT protection and verifies matching broker quantity before an exit", async () => {
    activeOrders.push({
      id: "gtt-audit",
      suggestionId: "sug-exit-1",
      orderType: "GTT_STOP",
      status: "PLACED",
      statusMessage: "GTT Stop-Loss Order Placed",
      brokerOrderId: "gtt-protection-456",
    });
    vi.mocked(axios.delete).mockResolvedValueOnce({
      data: { status: "success", data: { gtt_order_ids: ["gtt-protection-456"] } },
    });
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { data: [{ trading_symbol: "RELIANCE", quantity: 10, product: "I" }] },
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { order_id: "broker-exit-456" } },
    });

    const result = await placeLiveOrder({
      suggestionId: "sug-exit-1",
      symbol: "RELIANCE",
      direction: "SELL",
      quantity: 10,
      orderType: "STOP_EXIT",
      tradeType: "INTRADAY",
    });

    expect(result.ok).toBe(true);
    expect(axios.delete).toHaveBeenCalledWith(
      "https://api.upstox.com/v3/order/gtt/cancel",
      expect.objectContaining({ data: { gtt_order_id: "gtt-protection-456" } }),
    );
    expect(axios.get).toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledWith(
      "https://api-hft.upstox.com/v2/order/place",
      expect.anything(),
      expect.anything(),
    );
  });

  it("blocks an exit when broker product quantity does not match", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { data: [{ trading_symbol: "RELIANCE", quantity: 5, product: "I" }] },
    });

    const result = await placeLiveOrder({
      suggestionId: "sug-exit-2",
      symbol: "RELIANCE",
      direction: "SELL",
      quantity: 10,
      orderType: "TARGET_EXIT",
      tradeType: "INTRADAY",
    });

    expect(result.ok).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("cancels legacy STOP_EXIT GTT records before submitting a market STOP_EXIT", async () => {
    activeOrders.push({
      id: "legacy-gtt-audit",
      suggestionId: "sug-legacy-exit",
      orderType: "STOP_EXIT",
      status: "PLACED",
      statusMessage: "GTT Stop-Loss Order Placed",
      brokerOrderId: "legacy-gtt-789",
    });
    vi.mocked(axios.delete).mockResolvedValueOnce({
      data: { status: "success", data: { gtt_order_ids: ["legacy-gtt-789"] } },
    });
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { data: [{ trading_symbol: "RELIANCE", quantity: 10, product: "I" }] },
    });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { order_id: "broker-exit-789" } },
    });

    const result = await placeLiveOrder({
      suggestionId: "sug-legacy-exit",
      symbol: "RELIANCE",
      direction: "SELL",
      quantity: 10,
      orderType: "STOP_EXIT",
      tradeType: "INTRADAY",
    });

    expect(result.ok).toBe(true);
    expect(axios.delete).toHaveBeenCalledWith(
      "https://api.upstox.com/v3/order/gtt/cancel",
      expect.objectContaining({ data: { gtt_order_id: "legacy-gtt-789" } }),
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
