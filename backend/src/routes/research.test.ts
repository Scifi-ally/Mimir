import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const lab = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue(null),
  archive: vi.fn().mockResolvedValue(null),
  corporate: vi.fn().mockResolvedValue(null),
  backfill: vi.fn().mockResolvedValue(null),
  admission: vi.fn().mockResolvedValue(null),
  costs: vi.fn().mockResolvedValue(null),
  etfStudy: vi.fn().mockResolvedValue(null),
  etfSignal: vi.fn().mockResolvedValue(null),
  etfRun: vi.fn().mockResolvedValue({}),
  state: vi.fn(() => ({ running: null as string | null, liveAdmitted: false })),
}));
vi.mock("../analysis/strategy_lab", () => ({
  runStrategyJob: lab.run, readStrategyReport: lab.read, strategyLabState: lab.state,
  readExchangeArchiveStatus: lab.archive, readStrategyAdmission: lab.admission,
  readCorporateArchiveStatus: lab.corporate,
  readExchangeBackfillStatus: lab.backfill,
  readDeliveryCostStudy: lab.costs,
  readEtfRotationStudy: lab.etfStudy,
  readEtfRotationSignal: lab.etfSignal,
  runEtfSignalJob: lab.etfRun,
}));
vi.mock("../lib/redis", () => ({ redisClient: { status: "ready" } }));
import router from "./research";

const app = express().use(express.json()).use("/api", router);
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); lab.state.mockReturnValue({ running: null, liveAdmitted: false }); });

describe("protected strategy research API", () => {
  it("reports absent cost comparisons as null without creating data or orders", async () => {
    const response = await request(app).get("/api/research/delivery-costs");
    expect(response.status).toBe(200);
    expect(response.body.report).toBeNull();
    expect(response.body.liveAdmitted).toBe(false);
    expect(lab.run).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated remote work before starting a process", async () => {
    vi.stubEnv("UPSTOXBOT_ADMIN_TOKEN", "test-secret");
    vi.stubEnv("ALLOW_REMOTE_ADMIN", "false");
    vi.stubEnv("ALLOW_ALL_ORIGINS", "false");
    vi.stubEnv("ALLOW_TUNNELS", "false");
    const response = await request(app).post("/api/research/strategies/research").set("cf-ray", "remote");
    expect(response.status).toBe(401);
    expect(lab.run).not.toHaveBeenCalled();
  });
  it("never converts body fields into paths, shell commands or capital", async () => {
    const response = await request(app).post("/api/research/strategies/research")
      .send({ data: "../../.env", command: "malicious", capital: 999999999 });
    expect(response.status).toBe(202);
    expect(lab.run).toHaveBeenCalledExactlyOnceWith("research");
    expect(response.body.liveAdmitted).toBe(false);
  });
  it("reports missing evidence as null, without sample returns", async () => {
    const response = await request(app).get("/api/research/strategies");
    expect(response.status).toBe(200);
    expect(response.body.report).toBeNull();
    expect(response.body.forward).toBeNull();
    expect(response.body.admission).toBeNull();
  });
  it("refuses a concurrent job", async () => {
    lab.state.mockReturnValue({ running: "forward", liveAdmitted: false });
    expect((await request(app).post("/api/research/strategies/forward")).status).toBe(409);
    expect(lab.run).not.toHaveBeenCalled();
  });
  it("returns absent exchange receipts as null", async () => {
    const response = await request(app).get("/api/research/data");
    expect(response.status).toBe(200);
    expect(response.body.archive).toBeNull();
    expect(response.body.corporateActions).toBeNull();
    expect(response.body.backfill).toBeNull();
  });
  it("collects only official configured archives, ignoring request paths and dates", async () => {
    const response = await request(app).post("/api/research/data/collect")
      .send({ url: "http://127.0.0.1/internal", directory: "../../.env", date: "2099-01-01" });
    expect(response.status).toBe(202);
    expect(lab.run).toHaveBeenCalledExactlyOnceWith("archive");
  });
  it("returns etf rotation study and signal", async () => {
    lab.etfStudy.mockResolvedValue({ strategy: "etf_dual_momentum_rotation" });
    lab.etfSignal.mockResolvedValue({ target_symbol: "GOLDBEES" });
    const studyRes = await request(app).get("/api/research/etf-rotation");
    expect(studyRes.status).toBe(200);
    expect(studyRes.body.report).toEqual({ strategy: "etf_dual_momentum_rotation" });

    const sigRes = await request(app).get("/api/research/etf-signal");
    expect(sigRes.status).toBe(200);
    expect(sigRes.body.signal).toEqual({ target_symbol: "GOLDBEES" });
  });
});
