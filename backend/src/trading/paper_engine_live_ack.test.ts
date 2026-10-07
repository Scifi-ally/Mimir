import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: any) => unknown>();
  const paperPositionsTable = { status: "position.status", symbol: "position.symbol" };
  const paperAccountsTable = { id: "account.id" };
  const paperOrdersTable = { suggestionId: "order.suggestionId", orderType: "order.orderType", status: "order.status" };
  const suggestionsTable = { id: "suggestion.id" };
  const liveOrdersTable = { id: "live.id", status: "live.status", orderType: "live.orderType", statusMessage: "live.statusMessage", suggestionId: "live.suggestionId" };
  const position = {
    id: "position-1", suggestionId: "suggestion-1", symbol: "RELIANCE", direction: "BUY",
    quantity: 10, avgEntryPrice: "100.00", status: "OPEN", unrealizedPnl: "0.00",
    realizedPnl: "0.00", trailingStopLoss: "90.00",
  };
  const suggestion = { id: "suggestion-1", symbol: "RELIANCE", direction: "BUY", stopLoss: "90.00", target1: "110.00", setupType: "INTRADAY" };
  const account = { id: "account-1", balance: "500000.00", startingBalance: "500000.00", allocatedMargin: "200.00" };
  const insertValues: any[] = [];
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      let rows: any[] = [];
      const query = {
        from: vi.fn((value: unknown) => {
          table = value;
          return query;
        }),
        where: vi.fn(() => {
          if (table === paperPositionsTable) rows = [position];
          else if (table === suggestionsTable) rows = [suggestion];
          else rows = [];
          return query;
        }),
        limit: vi.fn(() => {
          if (table === paperAccountsTable) rows = [account];
          return query;
        }),
        orderBy: vi.fn(() => query),
        then: (resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    }),
    insert: vi.fn(() => ({ values: vi.fn((values: any) => { insertValues.push(values); return Promise.resolve([]); }) })),
    update: vi.fn(() => ({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    transaction: vi.fn(),
  };
  return { handlers, paperPositionsTable, paperAccountsTable, paperOrdersTable, suggestionsTable, liveOrdersTable, position, suggestion, account, insertValues, db };
});

vi.mock("../../db/src", () => ({ db: mocks.db, paperPositionsTable: mocks.paperPositionsTable, paperAccountsTable: mocks.paperAccountsTable, paperOrdersTable: mocks.paperOrdersTable, suggestionsTable: mocks.suggestionsTable, liveOrdersTable: mocks.liveOrdersTable }));
vi.mock("../../db/src/schema/paper_trading", () => ({ paperPositionsTable: mocks.paperPositionsTable, paperAccountsTable: mocks.paperAccountsTable, paperOrdersTable: mocks.paperOrdersTable }));
vi.mock("../../db/src/schema/suggestions", () => ({ suggestionsTable: mocks.suggestionsTable }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn((...args) => args), and: vi.fn((...args) => args), gte: vi.fn((...args) => args), inArray: vi.fn((...args) => args), sql: Object.assign(vi.fn((...args) => args), { raw: vi.fn() }) }));
vi.mock("../intelligence/event_bus", () => ({ intelligenceBus: { subscribe: vi.fn((event: string, handler: (event: any) => unknown) => { mocks.handlers.set(event, handler); return vi.fn(); }), publish: vi.fn() } }));
vi.mock("../config", () => ({ getConfig: vi.fn(() => ({ tradingMode: "LIVE", paperTradingEnabled: false, tradingCapital: 500000, maxDailyLossPct: 3, brokeragePerOrderInr: 20 })) }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../ws/websocket_server", () => ({ broadcast: vi.fn() }));
vi.mock("../ws/events", () => ({ createServerEvent: { positionUpdate: vi.fn((value) => value), systemAlert: vi.fn((value) => value) } }));
vi.mock("./broker_orders", () => ({ isLiveModeActive: vi.fn(() => true), placeLiveOrder: vi.fn(async () => ({ ok: true, liveOrderId: "live-1", brokerOrderId: "broker-1" })) }));
vi.mock("../lib/redis_state", () => ({ stateStore: { getTicks: vi.fn().mockResolvedValue([]) } }));
vi.mock("../analysis/calibration_engine", () => ({ getCalibration: vi.fn(), ensureFresh: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/ist-time", () => ({ todayStartUTC: vi.fn(() => new Date("2026-10-03T00:00:00Z")) }));
vi.mock("./adx_gate", () => ({ computeAdx14: vi.fn(), ADX_TREND_THRESHOLD: 25 }));

import { initPaperEngine } from "./paper_engine";
import { placeLiveOrder } from "./broker_orders";

describe("LIVE broker acknowledgements are not simulated fills", () => {
  afterEach(() => vi.clearAllMocks());

  it("keeps the position open and margin reserved without realizing PnL after an exit ACK", async () => {
    await initPaperEngine();
    const onTick = mocks.handlers.get("marketTick");
    expect(onTick).toBeDefined();

    await onTick!({ symbol: "RELIANCE", instrumentKey: "NSE_EQ:RELIANCE", ltp: 111, bid: 110.9, ask: 111.1, volume: 100, timestamp: Date.now(), source: "ws" });
    await vi.waitFor(() => expect(placeLiveOrder).toHaveBeenCalledTimes(1));

    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.insertValues).toEqual([expect.objectContaining({ orderType: "TARGET_EXIT", status: "SUBMITTED" })]);
    expect(mocks.position.status).toBe("OPEN");
    expect(mocks.position.realizedPnl).toBe("0.00");
    expect(mocks.account.allocatedMargin).toBe("200.00");
  });
});
