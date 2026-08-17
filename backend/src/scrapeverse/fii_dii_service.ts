import { desc, eq } from "drizzle-orm";
import { db } from "../../db/src";
import {
  institutionalFlowsTable,
  scrapeverseCollectorRunsTable,
  scrapeverseFiiDiiFlowsTable,
} from "../../db/src";
import { logger } from "../lib/logger";
import { collectFiiDii, type FiiDiiCollectionResult } from "./fii_dii_collector";

export async function persistFiiDiiCollection(result: FiiDiiCollectionResult): Promise<void> {
  const normalization = result.normalization;
  const completedAt = result.completedAt;
  const status = result.status === "completed"
    ? "SUCCEEDED"
    : result.status === "not_configured"
      ? "NOT_CONFIGURED"
      : "FAILED";

  await db.insert(scrapeverseCollectorRunsTable).values({
    collectorId: process.env.BRIGHT_DATA_FII_DII_COLLECTOR_ID?.trim() || "not-configured",
    collectionId: result.collectionId,
    sourceUrl: process.env.BRIGHT_DATA_FII_DII_SOURCE_URL?.trim() || "https://www.nseindia.com/reports/fii-dii",
    startedAt: result.startedAt,
    completedAt,
    status,
    rowsReceived: normalization?.rowsReceived ?? 0,
    rowsValid: normalization?.rowsValid ?? 0,
    completenessRate: normalization?.completenessRate ?? 0,
    lastError: result.reason,
    rawResponse: normalization ? { records: normalization.records, errors: normalization.errors } : null,
  }).onConflictDoNothing({ target: scrapeverseCollectorRunsTable.collectionId });

  if (!normalization || normalization.errors.length > 0 || normalization.records.length !== 2) return;

  for (const record of normalization.records) {
    await db.insert(scrapeverseFiiDiiFlowsTable).values({
      source: record.source,
      sourceUrl: record.sourceUrl,
      dataAsOf: record.dataAsOf,
      category: record.category,
      segment: record.segment,
      grossPurchaseCrore: record.grossPurchaseCrore,
      grossSalesCrore: record.grossSalesCrore,
      netCrore: record.netCrore,
      scrapedAt: record.scrapedAt,
      collectorId: record.collectorId,
      collectionId: record.collectionId,
      rawRecordHash: record.rawRecordHash,
      validationStatus: record.validationStatus,
      rawPayload: record.rawPayload,
    }).onConflictDoUpdate({
      target: [
        scrapeverseFiiDiiFlowsTable.source,
        scrapeverseFiiDiiFlowsTable.dataAsOf,
        scrapeverseFiiDiiFlowsTable.category,
        scrapeverseFiiDiiFlowsTable.segment,
      ],
      set: {
        grossPurchaseCrore: record.grossPurchaseCrore,
        grossSalesCrore: record.grossSalesCrore,
        netCrore: record.netCrore,
        scrapedAt: record.scrapedAt,
        collectorId: record.collectorId,
        collectionId: record.collectionId,
        rawRecordHash: record.rawRecordHash,
        validationStatus: record.validationStatus,
        rawPayload: record.rawPayload,
      },
    });
  }

  const fii = normalization.records.find((record) => record.category === "FII_FPI");
  const dii = normalization.records.find((record) => record.category === "DII");
  if (!fii || !dii || fii.dataAsOf !== dii.dataAsOf) return;

  // Keep existing regime/divergence consumers supplied from the validated
  // Scraper Studio rows, keyed by source date rather than scrape date.
  await db.insert(institutionalFlowsTable).values({
    date: fii.dataAsOf,
    fiiNet: fii.netCrore,
    diiNet: dii.netCrore,
    fiiIndexFuturesNet: 0,
    fiiStockFuturesNet: 0,
  }).onConflictDoUpdate({
    target: institutionalFlowsTable.date,
    set: {
      fiiNet: fii.netCrore,
      diiNet: dii.netCrore,
      fiiIndexFuturesNet: 0,
      fiiStockFuturesNet: 0,
    },
  });
}

export async function runAndPersistFiiDiiCollection(): Promise<FiiDiiCollectionResult> {
  const result = await collectFiiDii();
  try {
    await persistFiiDiiCollection(result);
  } catch (error) {
    logger.error({ err: error }, "Failed to persist Scrapeverse FII/DII collection");
    if (result.status === "completed") {
      return { ...result, status: "failed", reason: "collection succeeded but persistence failed" };
    }
  }
  return result;
}

export async function getScrapeverseFiiDiiLatest() {
  return db.select()
    .from(scrapeverseFiiDiiFlowsTable)
    .where(eq(scrapeverseFiiDiiFlowsTable.validationStatus, "VALID"))
    .orderBy(desc(scrapeverseFiiDiiFlowsTable.dataAsOf), desc(scrapeverseFiiDiiFlowsTable.scrapedAt))
    .limit(10);
}

export async function getScrapeverseCollectorHealth() {
  const [latestRun] = await db.select()
    .from(scrapeverseCollectorRunsTable)
    .orderBy(desc(scrapeverseCollectorRunsTable.startedAt))
    .limit(1);
  const recentRuns = await db.select({
    status: scrapeverseCollectorRunsTable.status,
    completenessRate: scrapeverseCollectorRunsTable.completenessRate,
    startedAt: scrapeverseCollectorRunsTable.startedAt,
  })
    .from(scrapeverseCollectorRunsTable)
    .orderBy(desc(scrapeverseCollectorRunsTable.startedAt))
    .limit(20);
  const successRuns = recentRuns.filter((run) => run.status === "SUCCEEDED");
  const completenessRate = recentRuns.length === 0
    ? null
    : Math.round((recentRuns.reduce((sum, run) => sum + run.completenessRate, 0) / recentRuns.length) * 10000) / 10000;
  return {
    configured: Boolean(process.env.BRIGHT_DATA_API_TOKEN?.trim() && process.env.BRIGHT_DATA_FII_DII_COLLECTOR_ID?.trim()),
    collectorId: process.env.BRIGHT_DATA_FII_DII_COLLECTOR_ID?.trim() || null,
    sourceUrl: process.env.BRIGHT_DATA_FII_DII_SOURCE_URL?.trim() || "https://www.nseindia.com/reports/fii-dii",
    lastRun: latestRun ?? null,
    recentRunCount: recentRuns.length,
    recentSuccessCount: successRuns.length,
    recentCompletenessRate: completenessRate,
  };
}
