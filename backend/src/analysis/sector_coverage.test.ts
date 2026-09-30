import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { classifyBySymbol, CURATED_SECTOR_BY_SYMBOL, isTradableEquityInstrument, type StockSector } from "./stock_scanner";

/**
 * Two guards over the real NSE instrument master.
 *
 * 1. The universe must contain only equities. Bonds and market-linked deposits
 *    carry segment NSE_EQ and an INE-prefixed ISIN, so ISIN/segment filtering
 *    cannot exclude them - 1,532 of 4,809 entries were bonds.
 *
 * 2. Sector classification must actually cover the universe. Every symbol still
 *    received *a* sector, so the old failure produced no error at all: 1,789
 *    equities resolved to "Other", which flattened rsVsSector60d (a ranker
 *    feature the shipped model splits on 13 times) into a near-constant and
 *    turned maxSectorExposure, default 2, into a global cap.
 *
 * The instrument master is gitignored and downloaded at runtime, so both skip
 * when it is absent rather than failing on a fresh clone.
 */
const INSTRUMENT_PATH = resolve(process.cwd(), "NSE.json.gz");

interface NseInstrument {
  instrument_key?: string;
  trading_symbol?: string;
  short_name?: string;
  name?: string;
}

function loadTradableEquities(): NseInstrument[] {
  const parsed = JSON.parse(gunzipSync(readFileSync(INSTRUMENT_PATH)).toString("utf-8"));
  const list: NseInstrument[] = Array.isArray(parsed) ? parsed : [];
  return list.filter((i) => isTradableEquityInstrument(i));
}

const hasMaster = existsSync(INSTRUMENT_PATH);
const describeIfMaster = hasMaster ? describe : describe.skip;

if (!hasMaster) {
  // eslint-disable-next-line no-console
  console.warn(
    "[universe coverage] NSE.json.gz not present - guards skipped. " +
      "It is downloaded on first scan; run a scan then re-run the tests.",
  );
}

describeIfMaster("NSE universe and sector coverage", () => {
  const equities = loadTradableEquities();

  it("has a populated instrument master to measure", () => {
    expect(equities.length).toBeGreaterThan(1500);
  });

  it("excludes bonds and structured notes, which are not equities", () => {
    // These are all real entries in the master that the old filter accepted,
    // because they carry segment NSE_EQ and an INE ISIN.
    const mustReject = [
      "885MFL28",   // MFL 8.85% 2028
      "820TOPO33",  // TOPO 8.20% 2033
      "SCL271224",  // SCL 0% 2026 SR III  (zero coupon, no leading digit)
      "PFCL41",     // PFCL 0% 2041 SR V
    ];
    for (const symbol of mustReject) {
      const entry = equities.find((e) => (e.trading_symbol ?? "").trim() === symbol);
      expect(entry, `${symbol} must not be treated as a tradable equity`).toBeUndefined();
    }

    // And the real equities must survive.
    for (const symbol of ["RELIANCE", "TCS", "HDFCBANK", "BAJAJ-AUTO", "M&M", "SUNPHARMA"]) {
      const entry = equities.find((e) => (e.trading_symbol ?? "").trim() === symbol);
      expect(entry, `${symbol} must be a tradable equity`).toBeDefined();
    }
  });

  it("resolves a far larger share of the universe to a real sector than before", () => {
    let resolved = 0;
    for (const inst of equities) {
      const sym = (inst.trading_symbol ?? "").trim();
      if (CURATED_SECTOR_BY_SYMBOL.get(sym) || classifyBySymbol(sym)) resolved += 1;
    }
    const coverage = resolved / equities.length;

    // HONEST NUMBER. Symbol-based rules resolve ~10% of the ~3,300 tradable NSE
    // equities, up from ~3% with the old 9-keyword company-name map. Most of the
    // remainder are mid and small caps whose ticker carries no sector signal
    // ("EIEL", "KCK", "VERTOZ"), and covering them properly needs a real sector
    // feed rather than more regexes.
    //
    // The floor is set just under the measured figure so a regression trips it.
    // It is deliberately NOT a high bar: claiming sector coverage we do not have
    // is the exact mistake this whole exercise is correcting.
    expect(
      coverage,
      `sector coverage ${(coverage * 100).toFixed(1)}% (was ~3% with the name map)`,
    ).toBeGreaterThan(0.08);
  });

  it("does not collapse the universe into a handful of giant buckets", () => {
    // A single "Other" holding ~77% of the universe was the actual failure.
    // Catch the shape of it even if the raw coverage number looks acceptable.
    const counts = new Map<StockSector, number>();
    let total = 0;
    for (const inst of equities) {
      const sym = (inst.trading_symbol ?? "").trim();
      const sector = CURATED_SECTOR_BY_SYMBOL.get(sym) ?? classifyBySymbol(sym);
      if (!sector) continue;
      counts.set(sector, (counts.get(sector) ?? 0) + 1);
      total += 1;
    }
    const largest = Math.max(...counts.values());
    expect(
      largest / total,
      `largest sector holds ${((largest / total) * 100).toFixed(1)}% of classified ` +
        `equities, which is the mega-bucket failure again`,
    ).toBeLessThan(0.6);

    // A real classification should reach most of the sector vocabulary.
    expect(counts.size).toBeGreaterThanOrEqual(10);
  });
});
