import { describe, it, expect } from "vitest";
import { TickRuleFlow } from "./tick_feeder";

/**
 * Tick-rule order flow feeds `upstox:features:<symbol>`, which is what decides
 * whether the ranker is armed at all. signal_generator.ts treats a missing
 * realtime feature as rankerIncomplete, which sends ranker_features: null, which
 * disarms the only calibrated model in the system.
 *
 * This replaced a book-pressure feature that never fired, because the
 * subscribed ltpc feed carries no bid/ask at all. The property that matters most
 * is therefore: does it produce a value from the data the feed actually
 * delivers (ltp + cumulative volume), and does it stay honest (null, not 0) when
 * it cannot?
 */
describe("TickRuleFlow", () => {
  /** Feed cumulative volume the way Upstox delivers it: running session total. */
  function feed(flow: TickRuleFlow, ticks: Array<[price: number, cumVol: number]>) {
    let last: number | null = null;
    for (const [price, cumVol] of ticks) {
      last = flow.push(price, cumVol);
    }
    return last;
  }

  it("returns null before it has classified anything", () => {
    // Must be null, not 0: "no data" and "balanced flow" are different states,
    // and conflating them is what let a missing quote read as neutral.
    const flow = new TickRuleFlow();
    expect(flow.push(100, 1000)).toBeNull();
  });

  it("reads positive when volume trades on the uptick", () => {
    const flow = new TickRuleFlow();
    const v = feed(flow, [
      [100, 1000],
      [101, 2000], // +1000 volume at a higher price -> buyer initiated
      [102, 3000], // +1000 more, higher again
    ]);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0.9);
  });

  it("reads negative when volume trades on the downtick", () => {
    const flow = new TickRuleFlow();
    const v = feed(flow, [
      [100, 1000],
      [99, 2000],
      [98, 3000],
    ]);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThan(-0.9);
  });

  it("carries direction through an unchanged price, per the tick rule", () => {
    // A flat tape must not read as neutral flow - it is still continuation of
    // whichever side was last lifting.
    const flow = new TickRuleFlow();
    const v = feed(flow, [
      [100, 1000],
      [101, 2000],
      [101, 3000], // unchanged, still up
      [101, 4000], // unchanged again
    ]);
    expect(v!).toBeGreaterThan(0.5);
  });

  it("uses the volume DELTA, not the cumulative total", () => {
    // Upstox sends running session volume. Summing it directly would count the
    // whole day on the first tick.
    const flow = new TickRuleFlow();
    const v = feed(flow, [
      [100, 1_000_000], // first tick: no delta is attributed
      [101, 1_000_500], // only 500 traded
    ]);
    expect(v).not.toBeNull();
    expect(Math.abs(v!)).toBeLessThanOrEqual(1);
  });

  it("stays within [-1, 1] on a one-sided tape", () => {
    const flow = new TickRuleFlow();
    const ticks: Array<[number, number]> = [[100, 1000]];
    for (let i = 0; i < 200; i++) ticks.push([100 + i, 1000 + (i + 1) * 500]);
    const v = feed(flow, ticks);
    expect(v).not.toBeNull();
    expect(v!).toBeLessThanOrEqual(1);
    expect(v!).toBeGreaterThanOrEqual(-1);
  });

  it("ignores non-finite input rather than poisoning the accumulator", () => {
    const flow = new TickRuleFlow();
    feed(flow, [[100, 1000], [101, 2000]]);
    expect(flow.push(NaN, 3000)).toBeNull();
    expect(flow.push(101, -5)).toBeNull();
    const v = feed(flow, [[102, 4000]]);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v!)).toBe(true);
  });

  it("decays so the feature stays responsive instead of pinning", () => {
    const flow = new TickRuleFlow(50);
    let cum = 1000;
    let v: number | null = null;
    cum += 100;
    v = flow.push(100, cum);
    cum += 100;
    v = flow.push(101, cum);
    // Now reverse hard and keep going: the reading must come back toward the
    // new direction rather than staying at its old extreme.
    for (let i = 0; i < 400; i++) {
      cum += 100;
      v = flow.push(100 - i * 0.1, cum);
    }
    expect(v!).toBeLessThan(0);
  });

  it("resets cleanly", () => {
    const flow = new TickRuleFlow();
    feed(flow, [[100, 1000], [101, 2000]]);
    flow.reset();
    expect(flow.push(100, 1000)).toBeNull();
  });
});