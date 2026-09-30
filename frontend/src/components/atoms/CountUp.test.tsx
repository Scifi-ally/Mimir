import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CountUp } from "./CountUp";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function text() {
  return container.textContent ?? "";
}

/**
 * Takes over rAF and performance.now() so the animation can be stepped by hand.
 * rAF timestamps are not on the same clock as performance.now() in jsdom, and
 * real timing here is not deterministic enough to assert on.
 * `start` is pinned to 0, so advancing to `t` ms means calling the captured
 * frame callback with that timestamp.
 */
function useManualClock() {
  let frame: FrameRequestCallback | null = null;

  vi.spyOn(globalThis, "performance", "get").mockReturnValue({
    now: () => 0,
  } as Performance);

  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
    frame = null;
  });

  return {
    /** Run one animation frame at the given timestamp (ms). */
    tick(t: number) {
      act(() => {
        const cb = frame;
        frame = null;
        cb?.(t);
      });
    },
  };
}

describe("CountUp", () => {
  it("renders the value immediately on first mount", () => {
    act(() => root.render(<CountUp value={1234.5} format={(v) => v.toFixed(2)} />));
    expect(text()).toBe("1234.50");
  });

  it("starts from the previous value on the first frame", () => {
    const clock = useManualClock();
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(2)} durationMs={200} />));
    act(() => root.render(<CountUp value={1100} format={(v) => v.toFixed(2)} durationMs={200} />));

    clock.tick(0);
    expect(text()).toBe("1000.00");
  });

  it("interpolates part-way through and lands exactly on the target", () => {
    const clock = useManualClock();
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(2)} durationMs={200} />));
    act(() => root.render(<CountUp value={1100} format={(v) => v.toFixed(2)} durationMs={200} />));

    clock.tick(100); // halfway
    const mid = Number(text());
    expect(mid).toBeGreaterThan(1000);
    expect(mid).toBeLessThan(1100);

    clock.tick(200); // complete
    expect(text()).toBe("1100.00");
  });

  it("eases out, so most of the distance is covered early", () => {
    const clock = useManualClock();
    act(() => root.render(<CountUp value={0} format={(v) => v.toFixed(2)} durationMs={200} />));
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(2)} durationMs={200} />));

    clock.tick(50); // 25% of the time
    const quarter = Number(text());
    // easeOutCubic(0.25) = 0.578, so a linear lerp would be 250.
    expect(quarter).toBeGreaterThan(400);
  });

  it("never overshoots the target (no spring bounce on financial values)", () => {
    const clock = useManualClock();
    act(() => root.render(<CountUp value={0} format={(v) => v.toFixed(2)} durationMs={200} />));
    act(() => root.render(<CountUp value={800} format={(v) => v.toFixed(2)} durationMs={200} />));

    let max = 0;
    for (const t of [20, 40, 60, 80, 100, 120, 140, 160, 180, 200]) {
      clock.tick(t);
      max = Math.max(max, Number(text()));
    }
    expect(max).toBeLessThanOrEqual(800);
  });

  it("animates downward too", () => {
    const clock = useManualClock();
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(2)} durationMs={200} />));
    act(() => root.render(<CountUp value={250} format={(v) => v.toFixed(2)} durationMs={200} />));

    clock.tick(200);
    expect(text()).toBe("250.00");
  });

  it("snaps on a first load rather than crawling from zero", () => {
    useManualClock();
    act(() => root.render(<CountUp value={0} format={(v) => v.toFixed(2)} durationMs={600} />));
    act(() => root.render(<CountUp value={5_000_000} format={(v) => v.toFixed(2)} durationMs={600} />));
    expect(text()).toBe("5000000.00");
  });

  it("snaps on close-out to zero", () => {
    useManualClock();
    act(() => root.render(<CountUp value={48_500} format={(v) => v.toFixed(2)} durationMs={600} />));
    act(() => root.render(<CountUp value={0} format={(v) => v.toFixed(2)} durationMs={600} />));
    expect(text()).toBe("0.00");
  });

  it("clamps a backwards rAF timestamp instead of exploding", () => {
    const clock = useManualClock();
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(2)} durationMs={200} />));
    act(() => root.render(<CountUp value={1100} format={(v) => v.toFixed(2)} durationMs={200} />));

    // A frame timestamp from before the animation started yields a negative t.
    // Unclamped, easeOutCubic(-0.5) is about -3.4, which would display ~366.
    clock.tick(-100);
    expect(text()).toBe("1000.00");

    // And it must still be able to reach the target afterwards.
    clock.tick(200);
    expect(text()).toBe("1100.00");
  });

  it("cancels its animation frame on unmount", () => {
    const clock = useManualClock();
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");
    // 1000 -> 1100 animates (1000 -> 900 would snap, scheduling no frame).
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(0)} durationMs={400} />));
    act(() => root.render(<CountUp value={1100} format={(v) => v.toFixed(0)} durationMs={400} />));
    clock.tick(100);

    act(() => root.unmount());
    root = createRoot(container); // so afterEach can unmount again cleanly

    expect(cancel).toHaveBeenCalled();
  });

  it("renders non-finite input without NaN leaking into the DOM", () => {
    act(() => root.render(<CountUp value={1000} format={(v) => v.toFixed(2)} />));
    act(() => root.render(<CountUp value={NaN} format={(v) => v.toFixed(2)} />));
    expect(text()).not.toContain("NaN");
  });
});
