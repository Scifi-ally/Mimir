import { describe, it, expect } from "vitest";
import { NSE_UNIVERSE, STOCK_SECTOR_MAP } from "./stock_scanner";

/**
 * The dynamic instrument listing is a symbol/key source, not a sector source.
 * It derives `sector` from the company name, which maps anything without a
 * sector keyword to "Other" ("Reliance Industries" -> "Other"). When that
 * guess was allowed to replace the curated NSE_UNIVERSE sector, the entire
 * sector map collapsed to "Other", degrading rsVsSector60d (a ranker feature)
 * and every STOCK_SECTOR_MAP consumer.
 */
describe("curated sector data survives universe loading", () => {
  it("assigns a real sector, not \"Other\", to a well-known name", () => {
    // "Reliance Industries" contains none of mapSectorFromName's keywords, so
    // the name-derived guess is "Other" while the curated value is "Energy".
    expect(STOCK_SECTOR_MAP["RELIANCE"]).toBe("Energy");
    expect(STOCK_SECTOR_MAP["RELIANCE"]).not.toBe("Other");
  });

  it("does not collapse the whole curated map to Other", () => {
    const others = NSE_UNIVERSE.filter((s) => s.sector === "Other");
    // Only a handful should genuinely be unclassified; a mass collapse to
    // "Other" is the exact regression this guards against.
    expect(others.length).toBeLessThan(NSE_UNIVERSE.length * 0.15);
  });

  it("covers the majority of the universe with a real sector", () => {
    const classified = NSE_UNIVERSE.filter((s) => s.sector && s.sector !== "Other");
    expect(classified.length / NSE_UNIVERSE.length).toBeGreaterThan(0.8);
  });

  it("every universe symbol resolves to a sector in the map", () => {
    for (const s of NSE_UNIVERSE) {
      expect(STOCK_SECTOR_MAP[s.symbol]).toBeDefined();
    }
  });
});
