import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { db, suggestionsTable } from "../db/src";
import { inArray } from "drizzle-orm";

async function extractConfluenceData() {
  const currentDir = fileURLToPath(new URL(".", import.meta.url));
  const outPath = path.resolve(currentDir, "../data/confluence_train.jsonl");
  mkdirSync(path.dirname(outPath), { recursive: true });

  const closed = await db
    .select({
      id: suggestionsTable.id,
      symbol: suggestionsTable.symbol,
      status: suggestionsTable.status,
      marketRegime: suggestionsTable.marketRegime,
      reasoning: suggestionsTable.reasoning,
      generatedAt: suggestionsTable.generatedAt,
      pnlInr: suggestionsTable.pnlInr,
    })
    .from(suggestionsTable)
    .where(inArray(suggestionsTable.status, ["TARGET_1_HIT", "TARGET_2_HIT", "STOP_HIT", "EXPIRED"]));

  let rowsWritten = 0;
  const lines: string[] = [];

  for (const trade of closed) {
    if (!trade.reasoning) continue;
    
    // Parse the reasoning string: e.g. "T:85 K:90 C:60 R:80 S:75 E:50"
    const techMatch = trade.reasoning.match(/T:([0-9]+)/);
    const patternMatch = trade.reasoning.match(/K:([0-9]+)/);
    const chronosMatch = trade.reasoning.match(/C:([0-9]+)/);
    const rsMatch = trade.reasoning.match(/R:([0-9]+)/);
    const sectorMatch = trade.reasoning.match(/S:([0-9]+)/);
    const sentimentMatch = trade.reasoning.match(/E:([0-9]+)/);

    const tech_score = techMatch ? parseInt(techMatch[1]!) : 50;
    const pattern_score = patternMatch ? parseInt(patternMatch[1]!) : 50;
    const chronos_score = chronosMatch ? parseInt(chronosMatch[1]!) : 50;
    const rs_score = rsMatch ? parseInt(rsMatch[1]!) : 50;
    const sector_score = sectorMatch ? parseInt(sectorMatch[1]!) : 50;
    const sentiment_score = sentimentMatch ? parseInt(sentimentMatch[1]!) : 50;

    const isWin = trade.status.includes("TARGET") || (trade.pnlInr && parseFloat(trade.pnlInr) > 0);
    const label = isWin ? 1 : 0;

    const row = {
      id: trade.id,
      symbol: trade.symbol,
      regime: trade.marketRegime || "UNKNOWN",
      generated_at: trade.generatedAt?.toISOString(),
      tech_score,
      pattern_score,
      chronos_score,
      rs_score,
      sector_score,
      sentiment_score,
      label
    };
    
    lines.push(JSON.stringify(row));
    rowsWritten++;
  }

  writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
  console.log(`Extracted ${rowsWritten} rows to ${outPath}`);
  
  return { rows: rowsWritten, outPath };
}

import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  extractConfluenceData().then(() => process.exit(0)).catch(console.error);
}

export { extractConfluenceData };
