import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FiiDiiCollectionResult } from "./fii_dii_collector";

export interface ScrapeverseEvidence {
  collector: "bright_data_scraper_studio";
  source: "NSE_FII_DII_CAPITAL_MARKET";
  verifiedAt: string;
  status: FiiDiiCollectionResult["status"];
  collectionId: string | null;
  reason: string | null;
  rowsReceived: number;
  rowsValid: number;
  completenessRate: number;
  records: unknown[];
}

export async function writeFiiDiiEvidence(
  result: FiiDiiCollectionResult,
  outputRoot = process.env.SCRAPEVERSE_EVIDENCE_DIR || path.resolve(process.cwd(), "evidence/scrapeverse"),
): Promise<string> {
  const normalization = result.normalization;
  const evidence: ScrapeverseEvidence = {
    collector: "bright_data_scraper_studio",
    source: "NSE_FII_DII_CAPITAL_MARKET",
    verifiedAt: new Date().toISOString(),
    status: result.status,
    collectionId: result.collectionId,
    reason: result.reason,
    rowsReceived: normalization?.rowsReceived ?? 0,
    rowsValid: normalization?.rowsValid ?? 0,
    completenessRate: normalization?.completenessRate ?? 0,
    records: normalization?.records ?? [],
  };
  await mkdir(outputRoot, { recursive: true });
  const suffix = result.collectionId?.replace(/[^a-zA-Z0-9_-]/g, "_") || "not-configured";
  const outputPath = path.join(outputRoot, `fii-dii-${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix}.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return outputPath;
}
