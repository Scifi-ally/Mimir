import { runAndPersistFiiDiiCollection } from "../src/scrapeverse/fii_dii_service";
import { writeFiiDiiEvidence } from "../src/scrapeverse/evidence";

const result = await runAndPersistFiiDiiCollection();
const evidencePath = await writeFiiDiiEvidence(result);
console.log(JSON.stringify({
  status: result.status,
  collectionId: result.collectionId,
  reason: result.reason,
  evidencePath,
  rowsReceived: result.normalization?.rowsReceived ?? 0,
  rowsValid: result.normalization?.rowsValid ?? 0,
  completenessRate: result.normalization?.completenessRate ?? 0,
}, null, 2));
process.exitCode = result.status === "completed" ? 0 : 2;
