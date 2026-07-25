import { db, suggestionsTable, rejectedCandidatesTable } from "../../db/src";
import { gte, desc } from "drizzle-orm";

async function run() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h

  const suggestions = await db
    .select({ decisionTrace: suggestionsTable.decisionTrace })
    .from(suggestionsTable)
    .where(gte(suggestionsTable.generatedAt, since));

  const rejections = await db
    .select({ decisionTrace: rejectedCandidatesTable.decisionTrace })
    .from(rejectedCandidatesTable)
    .where(gte(rejectedCandidatesTable.createdAt, since));

  console.log(`\n--- Decision Trace Report (Last 24h) ---`);
  console.log(`Total Accepted: ${suggestions.length}`);
  console.log(`Total Rejected: ${rejections.length}`);

  const paths: Record<string, number> = {};
  const gates: Record<string, number> = {};

  for (const s of suggestions) {
    if (s.decisionTrace && typeof s.decisionTrace === 'object') {
      const path = (s.decisionTrace as any).confidencePath || "unknown";
      paths[path] = (paths[path] || 0) + 1;
    }
  }

  for (const r of rejections) {
    if (r.decisionTrace && typeof r.decisionTrace === 'object') {
      const trace = r.decisionTrace as any;
      const gate = trace.rejectionGate || "unknown";
      gates[gate] = (gates[gate] || 0) + 1;
      
      const path = trace.confidencePath || "unknown";
      paths[path] = (paths[path] || 0) + 1;
    }
  }

  console.log(`\n--- Rejection Gates ---`);
  for (const [gate, count] of Object.entries(gates).sort((a, b) => b[1] - a[1])) {
    console.log(`${gate}: ${count}`);
  }

  console.log(`\n--- Confidence Paths (Accepted + Rejected) ---`);
  for (const [path, count] of Object.entries(paths).sort((a, b) => b[1] - a[1])) {
    console.log(`${path}: ${count}`);
  }

  process.exit(0);
}

run().catch(console.error);
