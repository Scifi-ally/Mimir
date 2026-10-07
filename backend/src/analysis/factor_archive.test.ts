import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeFactorReceipt, retainFactorReceipt } from "./factor_archive";
import { observeFactor } from "./factor_observation";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const capturedAt = "2026-10-04T16:00:00Z";
const factor = () => observeFactor(83.5, "INR/USD", "Yahoo: INR=X", capturedAt, capturedAt, 86400000, Date.parse(capturedAt));

describe("retained free-source factor observations", () => {
  it("hashes ordered measured fields and excludes extra payload fields", () => {
    const measured = Object.assign(factor(), { secret: "must not be retained" });
    const a = makeFactorReceipt({ usdInr: measured, another: factor() }, capturedAt);
    const b = makeFactorReceipt({ another: factor(), usdInr: factor() }, capturedAt);
    expect(a.sha256).toBe(b.sha256);
    expect(JSON.stringify(a)).not.toContain("must not be retained");
    expect(a.independentSourceVerification).toBe(false);
  });
  it("refuses a falsely available future or nonfinite observation", () => {
    const future = { ...factor(), availableAt: "2026-10-05T16:00:00Z" };
    expect(makeFactorReceipt({ usdInr: future }, capturedAt).factors.usdInr!.status).toBe("future");
    expect(makeFactorReceipt({ usdInr: { ...factor(), value: Infinity } }, capturedAt).factors.usdInr!.value).toBeNull();
  });
  it("retains actual missing states and writes immutable content-addressed files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-factor-test-"));
    directories.push(directory);
    const missing = { ...factor(), value: null, status: "missing" as const };
    const first = await retainFactorReceipt({ india10y: missing }, capturedAt, directory);
    const second = await retainFactorReceipt({ india10y: missing }, capturedAt, directory);
    expect(first.sha256).toBe(second.sha256);
    const file = path.join(directory, first.sha256 + ".json");
    expect(JSON.parse(await readFile(file, "utf8")).factors.india10y.value).toBeNull();
    await writeFile(file, "tampered");
    await expect(retainFactorReceipt({ india10y: missing }, capturedAt, directory)).rejects.toThrow("changed");
  });
});
