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
let statusWrites: string[] = [];

vi.mock("../db/src", () => ({
  db: {
    transaction: vi.fn().mockImplementation(async (run) => run({
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((val) => ({
          returning: vi.fn().mockResolvedValue([{ id: "test-live-order-123", ...val }]),
        })),
      })),
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockResolvedValue(existingOrdersInDb),
          })),
        })),
      })),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values) => {
        if (values?.status) statusWrites.push(values.status);
        return {
        where: vi.fn().mockResolvedValue({}),
        };
      }),
    }),
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
    statusWrites = [];
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

  it("does not treat a different placed exit type as a successful requested exit", async () => {
    existingOrdersInDb = [{
      id: "existing-stop-exit",
      suggestionId: "sug-cross-exit-12345",
      orderType: "STOP_EXIT",
      status: "PLACED",
      brokerOrderId: "broker-stop-101",
    }];

    const res = await placeLiveOrder({
      suggestionId: "sug-cross-exit-12345",
      symbol: "RELIANCE",
      direction: "SELL",
      quantity: 10,
      orderType: "TARGET_EXIT",
      tradeType: "INTRADAY",
    });

    expect(res.ok).toBe(false);
    expect(res.uncertain).toBe(true);
    expect(res.error).toContain("STOP_EXIT order already PLACED");
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("records lost acknowledgements as UNKNOWN and blocks resubmission", async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error("socket timeout"));

    const first = await placeLiveOrder({
      suggestionId: "sug-uncertain-12345",
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
    });

    expect(first.ok).toBe(false);
    expect(first.uncertain).toBe(true);
    expect(statusWrites).toContain("UNKNOWN");

    existingOrdersInDb = [{
      id: first.liveOrderId,
      suggestionId: "sug-uncertain-12345",
      orderType: "ENTRY",
      status: "UNKNOWN",
      brokerOrderId: null,
    }];
    vi.mocked(axios.post).mockClear();

    const retry = await placeLiveOrder({
      suggestionId: "sug-uncertain-12345",
      symbol: "RELIANCE",
      direction: "BUY",
      quantity: 10,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
    });

    expect(retry.ok).toBe(false);
    expect(retry.uncertain).toBe(true);
    expect(retry.error).toContain("already UNKNOWN");
    expect(axios.post).not.toHaveBeenCalled();
  });
});
