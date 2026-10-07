import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), unlink: vi.fn(), close: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), readFile: mocks.read, unlink: mocks.unlink,
  open: vi.fn(async () => ({ writeFile: vi.fn(), close: mocks.close })) }));
vi.mock("../config", () => ({ getConfig: () => ({ tradingCapital: 10000, maxRiskPerTradePct: 1 }) }));
import { runStrategyJob, strategyLabState } from "./strategy_lab";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockImplementation(async (file: string) => {
    if (file.endsWith("backfill-status.json")) return JSON.stringify({ state: "completed_with_gaps", verified_sessions: 803, invalid_reports: [] });
    throw Object.assign(new Error("not present"), { code: "ENOENT" });
  });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stderr: { resume: vi.fn() }, kill: vi.fn() });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
});

describe("actual research worker argument boundary", () => {
  it("uses the configured bounded planned-loss budget including execution costs", async () => {
    await runStrategyJob("research");
    const [, args] = mocks.spawn.mock.calls.find(([, argv]) => argv[0].endsWith("strategy_lab.py"))!;
    expect(args[args.indexOf("--risk-policy") + 1]).toBe("total_loss_budget");
    expect(args[args.indexOf("--maximum-risk-pct") + 1]).toBe("1");
  });
  it("uses fixed exchange/corporate sources, configured capital and no shell", async () => {
    await runStrategyJob("research");
    const job = mocks.spawn.mock.calls.find(([, args]) => args[0].endsWith("strategy_lab.py"));
    expect(job).toBeDefined();
    const args = job![1] as string[];
    expect(args[args.indexOf("--capital") + 1]).toBe("10000");
    expect(args[args.indexOf("--corporate-archives") + 1]).toMatch(/exchange_archive[\\/]historical_corporate$/);
    expect(args[args.indexOf("--data") + 1]).toMatch(/strategy_lab[\\/]exchange-candles.json$/);
    expect(mocks.spawn.mock.calls.every(([, , options]) => options.shell === false && options.windowsHide === true)).toBe(true);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.unlink).toHaveBeenCalledOnce();
    expect(strategyLabState().running).toBeNull();
  });
  it("releases its lock and reports a failed export without running or inventing research", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), { stderr: { resume: vi.fn() }, kill: vi.fn() });
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });
    await expect(runStrategyJob("research")).rejects.toThrow("Strategy job failed");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.unlink).toHaveBeenCalledOnce();
    expect(strategyLabState().lastJob?.error).toBe("Strategy worker failed; data or configuration needs review");
    expect(strategyLabState().running).toBeNull();
  });
});
