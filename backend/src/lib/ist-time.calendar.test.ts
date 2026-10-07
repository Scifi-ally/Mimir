import { describe, expect, it } from "vitest";
import { getLastCompletedTradingDayStr, getNextTradingDayStr, getPreviousTradingDayStr } from "./ist-time";

describe("calendar-aware trading date boundaries", () => {
  it("uses the actual preceding session across an amended holiday", () => {
    expect(getLastCompletedTradingDayStr(new Date("2026-01-15T16:00:00+05:30"))).toBe("2026-01-14");
    expect(getPreviousTradingDayStr(new Date("2026-01-16T10:00:00+05:30"))).toBe("2026-01-14");
  });
  it("skips a Monday holiday after the weekend", () => {
    expect(getNextTradingDayStr(new Date("2026-09-11T16:00:00+05:30"))).toBe("2026-09-15");
    expect(getLastCompletedTradingDayStr(new Date("2026-09-14T16:00:00+05:30"))).toBe("2026-09-11");
  });
  it("preserves official normal-hour weekend sessions", () => {
    expect(getNextTradingDayStr(new Date("2026-01-30T16:00:00+05:30"))).toBe("2026-02-01");
    expect(getLastCompletedTradingDayStr(new Date("2026-02-02T08:00:00+05:30"))).toBe("2026-02-01");
  });
});
