import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({ accounts: vi.fn(), positions: vi.fn(), historical: vi.fn() }));
vi.mock("../../db/src", () => ({ db: { select: () => ({ from: () => ({ limit: mocks.accounts, orderBy: mocks.positions }) }) } }));
vi.mock("../lib/yahoo-client", () => ({ yahooFinance: { historical: mocks.historical } }));
import { benchmarkRouter } from "./benchmark";
const app = express().use(benchmarkRouter);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.accounts.mockResolvedValue([{ startingBalance: "10000", balance: "10100" }]);
  mocks.positions.mockResolvedValue([{ status: "CLOSED", createdAt: new Date("2026-09-01") }]);
  mocks.historical.mockResolvedValue([{ close: 20000 }, { close: 20400 }]);
});
describe("benchmark evidence", () => {
  it("does not manufacture performance for an absent paper account", async () => {
    mocks.accounts.mockResolvedValue([]);
    const { body } = await request(app).get("/oos");
    expect(body.strategyReturnPct).toBeNull();
    expect(body.benchmarkReturnPct).toBeNull();
    expect(body.available).toBe(false);
  });
  it("does not turn a failed benchmark into zero or positive alpha", async () => {
    mocks.historical.mockRejectedValue(new Error("source unavailable"));
    const { body } = await request(app).get("/oos");
    expect(body.strategyReturnPct).toBe(1);
    expect(body.benchmarkReturnPct).toBeNull();
    expect(body.alphaPct).toBeNull();
    expect(body.benchmarkDifferencePct).toBeNull();
  });
  it("does not present realized balance as NAV with unmarked open exposure", async () => {
    mocks.positions.mockResolvedValue([{ status: "OPEN", createdAt: new Date("2026-09-01") }]);
    const { body } = await request(app).get("/oos");
    expect(body.strategyReturnPct).toBeNull();
    expect(body.reason).toBe("open_position_marks_unverified");
  });
  it("reports measured return difference without claiming factor alpha or untouched OOS", async () => {
    const { body } = await request(app).get("/oos");
    expect(body.strategyReturnPct).toBe(1);
    expect(body.benchmarkReturnPct).toBe(2);
    expect(body.benchmarkDifferencePct).toBe(-1);
    expect(body.alphaPct).toBeNull();
    expect(body.evidenceKind).toBe("recorded_paper_trades");
  });
});
