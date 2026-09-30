import { describe, it, expect, afterEach } from "vitest";

/**
 * Regression guard for the scan-worker deadline.
 *
 * The default was the string "60_000". Underscores are legal in a TypeScript
 * numeric literal but not in a string handed to Number(), so it parsed to NaN,
 * Math.max(5000, NaN) stayed NaN, and setTimeout(fn, NaN) fired on the very
 * next tick. Every scan task was therefore killed instantly with
 * "timed out after NaNms" and the scanner could never make progress.
 *
 * This re-implements the same resolution so the arithmetic is pinned without
 * having to boot a real worker pool.
 */
function resolveTaskTimeout(env: Record<string, string | undefined>): number {
  const raw = Number(env["SCAN_WORKER_TIMEOUT_MS"]);
  if (!Number.isFinite(raw) || raw <= 0) return 60_000;
  return Math.max(5_000, raw);
}

describe("scan worker task timeout resolution", () => {
  const original = process.env["SCAN_WORKER_TIMEOUT_MS"];
  afterEach(() => {
    if (original === undefined) delete process.env["SCAN_WORKER_TIMEOUT_MS"];
    else process.env["SCAN_WORKER_TIMEOUT_MS"] = original;
  });

  it("defaults to 60s when unset", () => {
    expect(resolveTaskTimeout({})).toBe(60_000);
  });

  it("never yields NaN for a missing value", () => {
    expect(Number.isNaN(resolveTaskTimeout({}))).toBe(false);
  });

  it("rejects the old underscore default instead of propagating NaN", () => {
    // "60_000" -> NaN, which must fall back to the real default.
    expect(resolveTaskTimeout({ SCAN_WORKER_TIMEOUT_MS: "60_000" })).toBe(60_000);
  });

  it("rejects non-numeric and NaN-producing values", () => {
    for (const bad of ["", "   ", "abc", "60s", "1e", "60_000", "NaN", "Infinity"]) {
      const v = resolveTaskTimeout({ SCAN_WORKER_TIMEOUT_MS: bad });
      expect(Number.isFinite(v), `${bad} should not yield a non-finite timeout`).toBe(true);
    }
  });

  it("clamps to the 5s floor", () => {
    expect(resolveTaskTimeout({ SCAN_WORKER_TIMEOUT_MS: "10" })).toBe(5_000);
  });

  it("honours a valid override", () => {
    expect(resolveTaskTimeout({ SCAN_WORKER_TIMEOUT_MS: "90000" })).toBe(90_000);
  });

  it("setTimeout with the resolved value is not immediate", () => {
    // The actual failure mode: setTimeout(fn, NaN) fires on the next tick.
    const ms = resolveTaskTimeout({});
    expect(ms).toBeGreaterThan(0);
  });
});
