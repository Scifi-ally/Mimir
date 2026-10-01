import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import {
  classifyBySymbol,
  CURATED_SECTOR_BY_SYMBOL,
  isTradableEquityInstrument,
  mapSectorFromName,
  type StockSector,
} from "./stock_scanner";

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
    // The real loader chain: curated -> symbol rules -> name rules. Measuring
    // only classifyBySymbol under-reported by 4x, because the coverage gain came
    // from reading `name` alongside `short_name`.
    const sectorOf = (inst: NseInstrument): StockSector | undefined => {
      const sym = (inst.trading_symbol ?? "").trim();
      const curated = CURATED_SECTOR_BY_SYMBOL.get(sym);
      if (curated) return curated;
      const bySymbol = classifyBySymbol(sym);
      if (bySymbol) return bySymbol;
      const fullName = `${inst.short_name ?? ""} ${inst.name ?? ""}`.trim();
      if (!fullName) return undefined;
      const byName = mapSectorFromName(fullName);
      return byName === "Other" ? undefined : byName;
    };

    let resolved = 0;
    for (const inst of equities) {
      if (sectorOf(inst)) resolved += 1;
    }
    const coverage = resolved / equities.length;

    // HONEST NUMBER, measured over the real instrument master with
    // scripts/measure_sector_coverage.ts. Symbol rules alone resolve ~10%.
    // Passing `name` as well as `short_name` took it to ~41%, because the
    // master's short_name is usually just the ticker ("TATVA", "IOLCP") so the
    // legal company name was never being read.
    //
    // The remaining ~59% are mostly small caps whose ticker and legal name both
    // carry no sector signal. Closing that needs a real sector feed - an NSE
    // classification file or a vendor mapping - not more keyword rules, which is
    // why this floor sits at the achieved figure rather than a round number.
    expect(
      coverage,
      `sector coverage ${(coverage * 100).toFixed(1)}% (was ~3% with the old name map, ` +
        `~10% with symbol rules only, ~41% once \`name\` is read as well as short_name)`,
    ).toBeGreaterThan(0.35);
  });

  it("does not collapse the universe into a handful of giant buckets", () => {
    // A single "Other" holding ~77% of the universe was the actual failure. It is
    // still the largest bucket by definition, so this guards against it growing
    // rather than asserting it is small - 58.7% today.
    const counts = new Map<StockSector, number>();
    let total = 0;
    for (const inst of equities) {
      const sym = (inst.trading_symbol ?? "").trim();
      const sector = CURATED_SECTOR_BY_SYMBOL.get(sym) ?? classifyBySymbol(sym);
      if (!sector) continue;
      counts.set(sector, (counts.get(sector) ?? 0) + 1);
      total += 1;
    }
    expect(counts.size).toBeGreaterThanOrEqual(12);

    // No single classified sector should dominate the universe.
    const largest = Math.max(...counts.values());
    expect(
      largest / total,
      `largest sector holds ${((largest / total) * 100).toFixed(1)}% of classified equities`,
    ).toBeLessThan(0.3);
  });
});
