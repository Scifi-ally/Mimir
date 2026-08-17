import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import { getBrightDataConfig, runBrightDataCollection, type BrightDataRunResult } from "./bright_data_client";

export const FII_DII_SOURCE = "NSE_FII_DII_CAPITAL_MARKET" as const;
export const FII_DII_SOURCE_URL = "https://www.nseindia.com/reports/fii-dii";
export const FII_DII_SEGMENT = "CAPITAL_MARKET" as const;

export type FiiDiiCategory = "FII_FPI" | "DII";
export type ValidationStatus = "VALID" | "INCOMPLETE" | "INVALID";

export interface NormalizedFiiDiiRecord {
  source: typeof FII_DII_SOURCE;
  sourceUrl: string;
  dataAsOf: string;
  category: FiiDiiCategory;
  segment: typeof FII_DII_SEGMENT;
  grossPurchaseCrore: number;
  grossSalesCrore: number;
  netCrore: number;
  scrapedAt: Date;
  collectorId: string;
  collectionId: string;
  rawRecordHash: string;
  validationStatus: ValidationStatus;
  rawPayload: Record<string, unknown>;
}

export interface FiiDiiNormalizationResult {
  records: NormalizedFiiDiiRecord[];
  rowsReceived: number;
  rowsValid: number;
  completenessRate: number;
  errors: string[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[₹,\s]/g, "").replace(/[()]/g, "-");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  if (iso) return iso;
  const numericMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (numericMatch) {
    const [, day, month, year] = numericMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const namedMatch = /^(\d{1,2})[- ]([A-Za-z]{3,})[- ](\d{4})$/.exec(text);
  if (!namedMatch) return null;
  const [, day, monthName, year] = namedMatch;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
  return month > 0 ? `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}` : null;
}

function normalizeCategory(value: unknown): FiiDiiCategory | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/\s+/g, "").replace(/\//g, "_");
  if (normalized === "FII_FPI" || normalized === "FII_FPI") return "FII_FPI";
  if (normalized === "DII") return "DII";
  return null;
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

export function normalizeFiiDiiRows(
  rows: unknown[],
  options: { collectorId: string; collectionId: string; sourceUrl?: string; scrapedAt?: Date },
): FiiDiiNormalizationResult {
  const scrapedAt = options.scrapedAt ?? new Date();
  const sourceUrl = options.sourceUrl ?? FII_DII_SOURCE_URL;
  const records: NormalizedFiiDiiRecord[] = [];
  const errors: string[] = [];
  // Completeness measures raw source fields only. Provenance fields are added
  // by this adapter and therefore cannot be used to inflate source quality.
  const expectedFields = 5;
  let observedFields = 0;

  for (const [index, raw] of rows.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`row ${index}: record is not an object`);
      continue;
    }
    const payload = raw as Record<string, unknown>;
    const category = normalizeCategory(field(payload, "category", "Category", "participant", "type"));
    const dataAsOf = parseDate(field(payload, "date", "Date", "data_as_of", "dataAsOf"));
    const grossPurchaseCrore = parseNumber(field(payload, "grossPurchase", "gross_purchase", "grossPurchaseCrore", "buyValue", "buy_value"));
    const grossSalesCrore = parseNumber(field(payload, "grossSales", "gross_sales", "grossSalesCrore", "sellValue", "sell_value"));
    const netCrore = parseNumber(field(payload, "netValue", "net_value", "netCrore", "net", "netPurchaseSales"));
    const fieldValues = [category, dataAsOf, grossPurchaseCrore, grossSalesCrore, netCrore];
    observedFields += fieldValues.filter((value) => value != null).length;

    if (!category || !dataAsOf || grossPurchaseCrore == null || grossSalesCrore == null || netCrore == null) {
      errors.push(`row ${index}: missing required FII/DII field`);
      continue;
    }
    if (grossPurchaseCrore < 0 || grossSalesCrore < 0) {
      errors.push(`row ${index}: gross values cannot be negative`);
      continue;
    }
    if (Math.abs((grossPurchaseCrore - grossSalesCrore) - netCrore) > 1.0) {
      errors.push(`row ${index}: net value does not reconcile with gross purchase minus gross sales`);
      continue;
    }

    const recordWithoutHash = {
      source: FII_DII_SOURCE,
      sourceUrl,
      dataAsOf,
      category,
      segment: FII_DII_SEGMENT,
      grossPurchaseCrore,
      grossSalesCrore,
      netCrore,
      collectorId: options.collectorId,
      collectionId: options.collectionId,
      rawPayload: payload,
    };
    const rawRecordHash = createHash("sha256").update(canonicalJson(recordWithoutHash)).digest("hex");
    records.push({
      ...recordWithoutHash,
      scrapedAt,
      rawRecordHash,
      validationStatus: "VALID",
    });
  }

  const completenessRate = rows.length === 0
    ? 0
    : Math.round((observedFields / (rows.length * expectedFields)) * 10000) / 10000;
  if (records.length !== 2) {
    errors.push(`expected exactly one valid FII/FPI row and one valid DII row; found ${records.length}`);
  }
  const categories = new Set(records.map((record) => record.category));
  if (!categories.has("FII_FPI") || !categories.has("DII")) {
    errors.push("required FII_FPI and DII categories are not both present");
  }

  return { records, rowsReceived: rows.length, rowsValid: records.length, completenessRate, errors };
}

export interface FiiDiiCollectionResult {
  status: BrightDataRunResult["status"];
  collectionId: string | null;
  startedAt: Date;
  completedAt: Date;
  normalization: FiiDiiNormalizationResult | null;
  reason: string | null;
}

export async function collectFiiDii(): Promise<FiiDiiCollectionResult> {
  const config = getBrightDataConfig();
  const startedAt = new Date();
  const result = await runBrightDataCollection({ config });
  if (result.status !== "completed") {
    const collectionId = "collectionId" in result ? result.collectionId ?? null : null;
    return {
      status: result.status,
      collectionId,
      startedAt,
      completedAt: new Date(),
      normalization: null,
      reason: result.reason,
    };
  }
  const normalization = normalizeFiiDiiRows(result.result.rows, {
    collectorId: config.collectorId!,
    collectionId: result.result.collectionId,
    sourceUrl: config.sourceUrl,
    scrapedAt: result.result.completedAt,
  });
  if (normalization.errors.length > 0) {
    logger.warn({ errors: normalization.errors }, "Scrapeverse FII/DII output is incomplete or invalid");
  }
  return {
    status: normalization.errors.length === 0 ? "completed" : "failed",
    collectionId: result.result.collectionId,
    startedAt: result.result.startedAt,
    completedAt: result.result.completedAt,
    normalization,
    reason: normalization.errors.length > 0 ? normalization.errors.join("; ") : null,
  };
}
