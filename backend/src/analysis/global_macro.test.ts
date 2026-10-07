import { describe, it, expect, vi } from "vitest";
const quote = vi.hoisted(() => vi.fn());
vi.mock("yahoo-finance2", () => ({ default: class { quote = quote; } }));
vi.mock("./gap_risk", () => ({ isEconomicEventDay: () => false, getTodayEconomicEvent: () => null }));
vi.mock("./factor_archive", () => ({ retainFactorReceipt: vi.fn().mockResolvedValue(undefined) }));
import { macroQuoteObservation, fetchGlobalMacroData, getGlobalMacroState } from "./global_macro";

describe("macro provenance", () => {
  it("requires source timestamps and rejects stale quotes", () => {
    const now = Date.parse("2026-10-04T10:00:00Z");
    expect(macroQuoteObservation({ regularMarketPrice: 7 }, "^IN10Y", "percent", now).value).toBeNull();
    expect(macroQuoteObservation({ regularMarketPrice: 7, regularMarketTime: new Date("2026-09-01") }, "^IN10Y", "percent", now).status).toBe("stale");
  });
  it("does not fabricate India yield or retain failed quotes as current", async () => {
    quote.mockImplementation(async (symbol: string) => symbol === "^IN10Y" ? null :
      { regularMarketPrice: 110, regularMarketTime: new Date() });
    const first = await fetchGlobalMacroData();
    expect(first.india10y).toBeNull();
    expect(first.india10yIsEstimate).toBe(false);
    expect(first.dxy).toBe(110);
    quote.mockResolvedValue(null);
    const failed = await fetchGlobalMacroData();
    expect(failed.dxy).toBeNull();
    expect(getGlobalMacroState().macroScore).toBe(0);
  });
});
