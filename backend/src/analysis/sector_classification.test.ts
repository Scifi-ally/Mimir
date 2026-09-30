import { describe, it, expect } from "vitest";
import { classifyBySymbol, NSE_UNIVERSE, type StockSector } from "./stock_scanner";

/**
 * Sector classification is not cosmetic. rsVsSector60d (ranker feature 12, split
 * on 13x by the shipped model) is a stock's relative strength divided by its
 * sector's, and maxSectorExposure (default 2) counts open positions per sector.
 * When 1,789 of 2,326 NSE equities fell into "Other", the first feature became a
 * near-constant and the second became a global cap.
 *
 * The realistic symbols below are the ones the audit found misbucketed.
 */
describe("classifyBySymbol", () => {
  it("classifies realistic NSE symbols that the old name-keyword map missed", () => {
    const cases: Array<[string, StockSector]> = [
      // These all have no sector keyword in their legal entity name, which is
      // exactly why they used to resolve to "Other".
      ["HDFCBANK", "Banks"],
      ["ICICIBANK", "Banks"],
      ["SBIN", "Banks"],
      ["AXISBANK", "Banks"],
      ["TATAMOTORS", "Auto"],
      ["MARUTI", "Auto"],
      ["SUNPHARMA", "Pharma"],
      ["CIPLA", "Pharma"],
      ["DRREDDY", "Pharma"],
      ["TATASTEEL", "Metals"],
      ["HINDALCO", "Metals"],
      ["INFY", "IT"],
      ["TCS", "IT"],
      ["WIPRO", "IT"],
      ["RELIANCE", "Energy"],
      ["ONGC", "Energy"],
      ["POWERGRID", "Energy"],
      ["BHARTIARTL", "Telecom"],
      ["LT", "Infrastructure"],
      ["ULTRACEMCO", "Cement"],
      ["ASIANPAINT", "Paints"],
      ["TITAN", "Consumer"],
      ["ITC", "FMCG"],
    ];
    for (const [symbol, expected] of cases) {
      expect(classifyBySymbol(symbol), symbol).toBe(expected);
    }
  });

  it("prefers the specific NBFC/AMC reading over the parent bank's", () => {
    // "HDFC" prefixes both the bank and several unrelated subsidiaries, so a
    // naive /BANK/ or /HDFC/ rule placed them all in Banks.
    expect(classifyBySymbol("HDFCAMC")).toBe("Financial Services");
    expect(classifyBySymbol("BAJAJFINSV")).toBe("Financial Services");
    expect(classifyBySymbol("HDFCBANK")).toBe("Banks");
  });

  it("does not let a Power utility fall through to Cement", () => {
    expect(classifyBySymbol("TATAPOWER")).toBe("Energy");
    expect(classifyBySymbol("NTPC")).toBe("Energy");
    expect(classifyBySymbol("ULTRACEMCO")).toBe("Cement");
  });

  it("returns null rather than guessing, so the caller can fall back", () => {
    expect(classifyBySymbol("ZZZNOTAREALSYMBOL")).toBeNull();
    expect(classifyBySymbol("")).toBeNull();
  });

  it("agrees with the curated map on every NSE_UNIVERSE entry it covers", () => {
    // The curated map is the authority where it exists. A symbol rule that
    // contradicts it is a bug in the rules, not a licence to override.
    const contradictions: string[] = [];
    for (const stock of NSE_UNIVERSE) {
      const inferred = classifyBySymbol(stock.symbol);
      if (inferred && inferred !== stock.sector) {
        contradictions.push(`${stock.symbol}: curated=${stock.sector} inferred=${inferred}`);
      }
    }
    expect(contradictions, contradictions.join("\n")).toEqual([]);
  });
});
