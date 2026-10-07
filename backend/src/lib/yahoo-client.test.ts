import { describe, expect, it } from "vitest";
import YahooFinance from "yahoo-finance2";
import { yahooFinance } from "./yahoo-client";

describe("installed Yahoo SDK integration", () => {
  it("uses a real SDK instance instead of the throwing v2 migration stubs", () => {
    expect(yahooFinance).toBeInstanceOf(YahooFinance);
    expect(yahooFinance.chart).not.toBe(YahooFinance.chart);
    expect(yahooFinance.quote).not.toBe(YahooFinance.quote);
    expect(yahooFinance.historical).not.toBe(YahooFinance.historical);
  });
});
