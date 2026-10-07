import { beforeEach, describe, expect, it, vi } from "vitest";
import recorded from "../../tests/fixtures/recorded_nse_daily.json";

const state = vi.hoisted(() => ({ contents: "", history: [] as any[], writes: 0, exists: false }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("./tick_distribution", () => ({ tickDistribution: {
  getAllCachedTicks: () => state.history.length ? [{ symbol: "RELIANCE" }] : [],
  getTickHistory: () => state.history,
} }));
vi.mock("fs/promises", () => ({ default: {
  mkdir: vi.fn(),
  open: async () => {
    if (!state.exists) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return {
      readLines: async function* () { for (const line of state.contents.trim().split("\n")) yield line; },
      close: vi.fn(),
    };
  },
  appendFile: async (_file: string, contents: string) => { state.contents += contents; state.exists = true; state.writes++; },
} }));

describe("tick archive observation deduplication", () => {
  beforeEach(() => {
    vi.resetModules();
    state.contents = ""; state.history = []; state.writes = 0; state.exists = false;
  });
  it("retains late and distinct same-millisecond observations and restores restart overlap", async () => {
    const now = Date.now();
    // Prices come from recorded vendor candles. Only event ordering is a test input.
    const prices = Object.values(recorded.bars)[0]!.slice(98, 101).map((c) => c[4]);
    const first = { timestamp: now, ltp: prices[0], sequence: 1 };
    state.history = [first];
    const archive = await import("./tick_archiver");
    await Promise.all([archive.archiveDailyTicks(), archive.archiveDailyTicks()]);
    state.history.push({ timestamp: now - 500, ltp: prices[1], sequence: 2 });
    state.history.push({ timestamp: now, ltp: prices[2], sequence: 3 });
    await archive.archiveDailyTicks();
    vi.resetModules();
    const restarted = await import("./tick_archiver");
    await restarted.archiveDailyTicks();
    const ticks = state.contents.trim().split("\n").flatMap((row) => JSON.parse(row).tickData);
    expect(ticks.map((tick: any) => tick.sequence)).toEqual([1, 2, 3]);
    expect(state.writes).toBe(2);
  });
  it("does not append over a corrupt durable archive", async () => {
    state.exists = true; state.contents = "{partial";
    state.history = [{ timestamp: Date.now(), ltp: 1, sequence: 1 }];
    const { archiveDailyTicks } = await import("./tick_archiver");
    await expect(Promise.all([archiveDailyTicks(), archiveDailyTicks()])).resolves.toEqual([undefined, undefined]);
    expect(state.writes).toBe(0);
  });
});
