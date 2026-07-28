import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { placeLiveOrder } from "../src/trading/broker_orders";
import * as configModule from "../src/config";
import * as authModule from "../src/upstox/auth";
import * as scannerModule from "../src/analysis/stock_scanner";
import { db } from "../db/src";

vi.mock("axios");
vi.mock("../src/config");
vi.mock("../src/upstox/auth");
vi.mock("../src/analysis/stock_scanner");

let existingOrdersInDb: Array<{ id: string; suggestionId: string; orderType: string; status: string; brokerOrderId: string | null }> = [];

vi.mock("../db/src", () => ({
  db: {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((val) => {
        const created = { id: "test-live-order-123", ...val };
        return {
          returning: vi.fn().mockResolvedValue([created]),
        };
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({}),
      }),
    }),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => Promise.resolve(existingOrdersInDb)),
        })),
      })),
    })),
  },
  liveOrdersTable: {
    id: "id",
    suggestionId: "suggestionId",
    orderType: "orderType",
    status: "status",
  },
}));

describe("Broker Orders Pre-Flight Idempotency Guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existingOrdersInDb = [];
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

  it("should place order successfully when no duplicate suggestion order exists", async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: { data: { order_id: "broker-order-101" } },
    });

    const res = await placeLiveOrder({
      suggestionId: "sug-abc-12345",
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
    });

    expect(res.ok).toBe(true);
    expect(res.brokerOrderId).toBe("broker-order-101");
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      "https://api-hft.upstox.com/v2/order/place",
      expect.objectContaining({
        tag: expect.stringMatching(/^mimir-entr-sug-abc-/),
      }),
      expect.anything()
    );
  });

  it("should block duplicate order attempt and prevent extra network requests upon retry", async () => {
    // Simulate DB having a prior PENDING or PLACED order for this suggestion & orderType
    existingOrdersInDb = [
      {
        id: "existing-live-order-1",
        suggestionId: "sug-abc-12345",
        orderType: "ENTRY",
        status: "PLACED",
        brokerOrderId: "broker-order-101",
      },
    ];

    const retryRes = await placeLiveOrder({
      suggestionId: "sug-abc-12345",
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
    });

    expect(retryRes.ok).toBe(true); // returns previous PLACED status
    expect(retryRes.liveOrderId).toBe("existing-live-order-1");
    expect(retryRes.brokerOrderId).toBe("broker-order-101");
    expect(retryRes.error).toContain("Duplicate order blocked");

    // CRITICAL Assertion: Axios post was NEVER called on the duplicate retry!
    expect(axios.post).not.toHaveBeenCalled();
  });
});
