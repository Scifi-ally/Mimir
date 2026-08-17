import { describe, expect, it } from "vitest";
import { normalizeFiiDiiRows } from "./fii_dii_collector";
import { getBrightDataConfig, runBrightDataCollection } from "./bright_data_client";

describe("Scrapeverse FII/DII collector", () => {
  const options = {
    collectorId: "c_test_fii_dii",
    collectionId: "j_test_collection",
    scrapedAt: new Date("2026-08-17T12:00:00.000Z"),
  };

  it("normalizes valid FII/FPI and DII rows with separate provenance", () => {
    const result = normalizeFiiDiiRows([
      {
        date: "17-Aug-2026",
        category: "FII/FPI",
        grossPurchase: "12,763.43",
        grossSales: "13,503.43",
        netValue: "-740.00",
      },
      {
        date: "17-Aug-2026",
        category: "DII",
        grossPurchase: "15,000.00",
        grossSales: "13,500.00",
        netValue: "1,500.00",
      },
    ], options);

    expect(result.errors).toEqual([]);
    expect(result.rowsReceived).toBe(2);
    expect(result.rowsValid).toBe(2);
    expect(result.completenessRate).toBe(1);
    expect(result.records.map((row) => row.category)).toEqual(["FII_FPI", "DII"]);
    expect(result.records[0]?.dataAsOf).toBe("2026-08-17");
    expect(result.records[0]?.scrapedAt.toISOString()).toBe("2026-08-17T12:00:00.000Z");
    expect(result.records[0]?.rawRecordHash).toHaveLength(64);
  });

  it("rejects a row when net does not reconcile with gross values", () => {
    const result = normalizeFiiDiiRows([
      {
        date: "2026-08-17",
        category: "FII/FPI",
        grossPurchase: 100,
        grossSales: 50,
        netValue: 1,
      },
    ], options);

    expect(result.records).toHaveLength(0);
    expect(result.errors.some((error) => error.includes("does not reconcile"))).toBe(true);
    expect(result.completenessRate).toBe(1);
  });

  it("flags incomplete output when one required participant category is missing", () => {
    const result = normalizeFiiDiiRows([
      {
        date: "2026-08-17",
        category: "DII",
        grossPurchase: 100,
        grossSales: 80,
        netValue: 20,
      },
    ], options);

    expect(result.records).toHaveLength(1);
    expect(result.errors.some((error) => error.includes("expected exactly one valid"))).toBe(true);
    expect(result.errors.some((error) => error.includes("required FII_FPI"))).toBe(true);
  });

  it("does not claim a live collection when Bright Data credentials are absent", async () => {
    const env = {
      BRIGHT_DATA_API_TOKEN: "",
      BRIGHT_DATA_FII_DII_COLLECTOR_ID: "",
    } as NodeJS.ProcessEnv;
    const config = getBrightDataConfig(env);
    const result = await runBrightDataCollection({ config });
    expect(result.status).toBe("not_configured");
  });
});
