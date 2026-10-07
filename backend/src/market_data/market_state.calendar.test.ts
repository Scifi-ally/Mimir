import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSessionPhase, getTargetTradingSessionDate } from "./market_state";

afterEach(() => vi.useRealTimers());

describe("verified NSE normal-session calendar", () => {
  it.each(["2026-01-15", "2026-03-26", "2026-03-31", "2026-05-28", "2026-09-14", "2026-10-20", "2026-11-10", "2026-11-24"])
    ("keeps %s closed according to exchange circulars", date => {
      vi.useFakeTimers(); vi.setSystemTime(new Date(`${date}T11:00:00+05:30`));
      expect(computeSessionPhase()).toBe("OFF_HOURS");
      expect(getTargetTradingSessionDate()).not.toBe(date);
    });
  it.each(["2026-03-24", "2026-04-02", "2026-09-07", "2026-10-21", "2026-11-09", "2026-11-23"])
    ("does not invent a holiday on %s", date => {
      vi.useFakeTimers(); vi.setSystemTime(new Date(`${date}T11:00:00+05:30`));
      expect(computeSessionPhase()).toBe("MARKET");
    });
  it.each(["2025-02-01", "2026-02-01"])("recognizes the official budget weekend session %s", date => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(`${date}T11:00:00+05:30`));
    expect(computeSessionPhase()).toBe("MARKET");
  });
});
