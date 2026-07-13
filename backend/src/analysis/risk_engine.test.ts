import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupCandidate, TechnicalSnapshot } from "./technical";

const config = {
  tradingCapital: 100_000,
  maxRiskPerTradePct: 1,
  maxDailyLossPct: 3,
  maxOpenPositions: 3,
  maxSectorExposure: 2,
  minRiskReward: 1.8,
  minDailyVolume: 100_000,
  vixPauseThreshold: 22,
  minSuggestionScore: 5.5,
  minMtfConfluencePct: 45,
  minAutoConfidencePct: 55,
  brokeragePerOrderInr: 20,
  slippageBps: 5,
  confidenceThresholdByRegimeJson: "{}",
  maxSameDirectionOpenPositions: 2,
  avoidFirstMinutes: 10,
  avoidMiddayStartMinute: 150,
  avoidMiddayEndMinute: 225,
  weeklyLossLimitPct: 6,
  rollingDrawdownPct: 8,
  maxDeployedCapitalPct: 90,
  upstoxApiKey: "",
  upstoxApiSecret: "",
  upstoxRedirectUri: "",
};

vi.mock("../config", () => ({
  getConfig: () => config,
}));

vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../db/src", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => []),
      })),
    })),
  },
}));

vi.mock("../../db/src/schema/suggestions", () => ({
  suggestionsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../lib/ist-time", () => ({
  todayStartUTC: () => new Date("2026-01-01T00:00:00.000Z"),
}));

vi.mock("./stock_scanner", () => ({
  STOCK_SECTOR_MAP: {},
}));

const setup: SetupCandidate = {
  setupType: "BREAKOUT",
  direction: "BUY",
  score: 8,
  entryPrice: 100,
  stopLoss: 98,
  target1: 104,
  target2: 108,
  riskReward: 2,
  reasoning: "test",
  confluence: [],
};

const snapshot: TechnicalSnapshot = {
  close: 100,
  ema9: 101,
  ema20: 100,
  ema50: 99,
  ema200: 98,
  rsi14: 55,
  atr14: 2,
  volumeRatio: 1.5,
  adx14: 24,
  high52w: 120,
  low52w: 80,
  distFromEma20Pct: 0,
  trend: "UP",
  avgDailyVolume: 1000000,
  swingLow: 95,
  swingHigh: 105,
  vwap: 100,
  superTrend: 90,
  vpvrPOC: 100,
  volumeAnomaly: false,
};

describe("risk engine", async () => {
  const risk = await import("./risk_engine");

  beforeEach(() => {
    Object.assign(config, {
      tradingCapital: 100_000,
      maxRiskPerTradePct: 1,
      maxDailyLossPct: 3,
      maxOpenPositions: 3,
      maxSectorExposure: 2,
      minRiskReward: 1.8,
      minDailyVolume: 100_000,
      maxSameDirectionOpenPositions: 2,
      maxDeployedCapitalPct: 90,
    });
    risk.updateOpenPositions([]);
    risk.updateDailyPnl(0, 0);
  });

  it("passes a liquid setup with acceptable risk and position sizing", async () => {
    const result = await risk.assessRisk(setup, snapshot, "IT", { symbol: "INFY" } as never);

    expect(result.passed).toBe(true);
    expect(result.positionSize).toBe(200);
    expect(result.investmentAmount).toBe(20_000);
    expect(result.maxRiskInr).toBe(400);
    expect(result.riskPercentage).toBe(0.4);
  });

  it("uses configured minimum risk-reward instead of a hardcoded threshold", async () => {
    config.minRiskReward = 2.5;

    const result = await risk.assessRisk({ ...setup, riskReward: 2.1 }, snapshot, "IT");

    expect(result.passed).toBe(false);
    expect(result.rejectionReasons.join(" ")).toContain("below auto-tuned minimum 2.50");
  });

  it("does not force a one-share position when the position cap cannot afford it", async () => {
    config.tradingCapital = 1_000;

    const result = await risk.assessRisk({ ...setup, entryPrice: 2_000, stopLoss: 1_990 }, snapshot, "IT");

    expect(result.positionSize).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("rejects only actual losses when checking the daily loss limit", async () => {
    risk.updateDailyPnl(5_000, 0);
    expect((await risk.assessRisk(setup, snapshot, "IT")).dailyLossLimitOk).toBe(true);

    risk.updateDailyPnl(-3_500, 1);
    const result = await risk.assessRisk(setup, snapshot, "IT");

    expect(result.dailyLossLimitOk).toBe(false);
    expect(result.rejectionReasons.join(" ")).toContain("Daily loss limit reached");
  });

  it("rejects duplicate same-direction positions", async () => {
    risk.updateOpenPositions([
      { symbol: "INFY", sector: "IT", direction: "BUY", entryPrice: 100, quantity: 10, maxRiskInr: 100 },
    ]);

    const result = await risk.assessRisk(setup, snapshot, "IT", { symbol: "INFY" } as never);

    expect(result.passed).toBe(false);
    expect(result.rejectionReasons.join(" ")).toContain("Already have an open BUY position");
  });

  it("rejects when aggregate deployed capital exceeds limit", async () => {
    config.maxDeployedCapitalPct = 50;
    config.maxSameDirectionOpenPositions = 5;
    config.maxSectorExposure = 5;
    risk.updateOpenPositions([
      { symbol: "TCS", sector: "IT", direction: "BUY", entryPrice: 3000, quantity: 10, maxRiskInr: 500 },
      { symbol: "WIPRO", sector: "IT", direction: "BUY", entryPrice: 500, quantity: 40, maxRiskInr: 200 },
    ]);
    // Already deployed: 3000*10 + 500*20 = 40,000. Max at 50% = 50,000. New trade = 100*200 = 20,000. Total = 60,000 > 50,000
    const result = await risk.assessRisk(setup, snapshot, "IT", { symbol: "RELIANCE" } as never);
    expect(result.rejectionReasons.join(" ")).toContain("deployed capital");
  });
});
