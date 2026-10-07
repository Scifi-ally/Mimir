import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { observeFactor, type FactorObservation } from "./factor_observation";

const root = existsSync(path.resolve("backend/ai_service/strategy_lab.py")) ? path.resolve(".") : path.resolve("..");
const defaultDirectory = path.join(root, "backend/data/factor_archive");

export function makeFactorReceipt(observations: Record<string, FactorObservation>, capturedAt = new Date().toISOString()) {
  const now = Date.parse(capturedAt);
  if (!Number.isFinite(now)) throw new Error("Valid factor capture timestamp required");
  const factors: Record<string, FactorObservation> = {};
  for (const key of Object.keys(observations).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error("Invalid factor key");
    const value = observations[key]!;
    if (!value || typeof value.source !== "string" || value.source.length > 256 || typeof value.unit !== "string" || value.unit.length > 64) {
      throw new Error("Invalid factor provenance");
    }
    const checked = observeFactor(value.value, value.unit, value.source, value.observedAt,
      value.availableAt, value.maxAgeMs, now, value.kind);
    // Preserve explicitly recorded failures; never promote a claimed available
    // future/stale/nonfinite observation just because a receipt was written.
    factors[key] = value.status !== "available" && value.value === null
      ? { ...checked, status: value.status, reason: value.reason?.slice(0, 256) } : checked;
  }
  const body = { version: 1, capturedAt, factors, source: "local_free_feed_observations",
    historicalBackfill: false, predictiveValidation: "not_established", independentSourceVerification: false };
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, sha256 };
}

export async function retainFactorReceipt(observations: Record<string, FactorObservation>, capturedAt = new Date().toISOString(), directory = defaultDirectory) {
  const receipt = makeFactorReceipt(observations, capturedAt);
  const data = JSON.stringify(receipt, null, 2);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, receipt.sha256 + ".json");
  try { await writeFile(file, data, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(file, "utf8") !== data) throw new Error("Existing factor receipt changed");
  }
  return receipt;
}
