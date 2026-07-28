import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import axios from "axios";
import { placeLiveOrder, fetchBrokerPositions, fetchBrokerFunds } from "../src/trading/broker_orders";
import * as configModule from "../src/config";
import * as authModule from "../src/upstox/auth";
import * as scannerModule from "../src/analysis/stock_scanner";

// Mock DB queries so database reads/writes resolve cleanly during sandbox testing
vi.mock("../db/src", () => ({
  db: {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((val) => ({
        returning: vi.fn().mockResolvedValue([{ id: "sandbox-audit-id-001", ...val }]),
      })),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({}),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
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

describe("Broker Orders Sandbox / Mock Upstox V2 Integration", () => {
  let mockServer: http.Server;
  let mockServerPort: number;
  let lastReceivedPayload: any = null;
  let lastReceivedHeaders: any = null;

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.spyOn(configModule, "getConfig").mockReturnValue({
      tradingMode: "LIVE",
      paperTradingEnabled: false,
    } as any);

    vi.spyOn(authModule, "getAccessToken").mockReturnValue("sandbox_access_token_xyz");
    vi.spyOn(scannerModule, "findStockBySymbol").mockResolvedValue({
      symbol: "TATASTEEL",
      key: "NSE_EQ:INE081A01020",
    } as any);

    // Create an actual local HTTP server acting as Upstox V2 sandbox API endpoint
    await new Promise<void>((resolve) => {
      mockServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastReceivedHeaders = req.headers;
          lastReceivedPayload = body ? JSON.parse(body) : null;

          res.setHeader("Content-Type", "application/json");
          if (req.url?.includes("/order/place")) {
            res.writeHead(200);
            res.end(JSON.stringify({ status: "success", data: { order_id: "UPSTOX-SBX-ORDER-9999" } }));
          } else if (req.url?.includes("/portfolio/short-term-positions")) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                status: "success",
                data: [
                  {
                    trading_symbol: "TATASTEEL",
                    quantity: 50,
                    buy_price: 150.0,
                    last_price: 155.0,
                    pnl: 250.0,
                    product: "I",
                  },
                ],
              })
            );
          } else if (req.url?.includes("/user/get-funds-and-margin")) {
            res.writeHead(200);
            res.end(
              JSON.stringify({
                status: "success",
                data: {
                  equity: {
                    available_margin: 250000.5,
                    used_margin: 15000.0,
                  },
                },
              })
            );
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ status: "error", message: "Not found" }));
          }
        });
      });

      mockServer.listen(0, "127.0.0.1", () => {
        const address = mockServer.address() as { port: number };
        mockServerPort = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it("should place order against local Upstox sandbox server with valid V2 schema and bearer token", async () => {
    // Intercept axios request to point to local sandbox server
    const originalPost = axios.post;
    vi.spyOn(axios, "post").mockImplementation((url, data, config) => {
      if (typeof url === "string" && url.includes("upstox.com")) {
        const localUrl = url.replace(/https:\/\/[^/]+/, `http://127.0.0.1:${mockServerPort}`);
        return originalPost(localUrl, data, config);
      }
      return originalPost(url, data, config);
    });

    const result = await placeLiveOrder({
      symbol: "TATASTEEL",
      direction: "BUY",
      quantity: 50,
      orderType: "ENTRY",
      tradeType: "INTRADAY",
      referencePrice: 150.0,
    });

    expect(result.ok).toBe(true);
    expect(result.brokerOrderId).toBe("UPSTOX-SBX-ORDER-9999");
    expect(lastReceivedHeaders["authorization"]).toBe("Bearer sandbox_access_token_xyz");
    expect(lastReceivedPayload).toEqual(
      expect.objectContaining({
        quantity: 50,
        product: "I",
        validity: "DAY",
        instrument_token: "NSE_EQ|INE081A01020",
        order_type: "MARKET",
        transaction_type: "BUY",
      })
    );
  });
});
