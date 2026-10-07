import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../config";

// Works from root, backend workspace and bundled backend/dist entrypoints.
const root = existsSync(path.resolve("backend/ai_service/strategy_lab.py"))
  ? path.resolve(".") : path.resolve("..");
const directory = path.join(root, "backend/data/strategy_lab");
const source = path.join(directory, "recorded-candles.json");
const archiveDirectory = path.join(root, "backend/data/exchange_archive");
const python = process.env["MIMIR_PYTHON"] || (existsSync(path.join(root, ".venv/Scripts/python.exe"))
  ? path.join(root, ".venv/Scripts/python.exe") : existsSync(path.join(root, ".venv/bin/python"))
    ? path.join(root, ".venv/bin/python") : "python");
let running: "research" | "forward" | "archive" | "corporate" | null = null;
let lastJob: { mode: string; startedAt: string; finishedAt: string | null; error: string | null } | null = null;

export function strategyLabState() { return { running, lastJob, mode: "research_and_shadow_paper", liveAdmitted: false }; }

async function pythonScript(script: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [path.join(root, script), ...args], { cwd: root, windowsHide: true, shell: false,
      stdio: ["ignore", "ignore", "pipe"] });
    // Raw exception messages can contain a database URL; don't expose process output.
    child.stderr?.resume();
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Strategy job timed out")); }, 1_200_000);
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Python strategy worker unavailable")); });
    child.once("close", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error("Strategy job failed: data, journal or configuration needs review")); });
  });
}

export async function readStrategyReport(forward=false): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(directory, forward ? "forward-status.json" : "latest.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readExchangeArchiveStatus(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(archiveDirectory, "status.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readStrategyAdmission(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(directory, "admission-status.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readDeliveryCostStudy(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(directory, "delivery_cost_comparison/latest.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readCorporateArchiveStatus(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(archiveDirectory, "corporate-status.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readExchangeBackfillStatus(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(archiveDirectory, "backfill-status.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function runStrategyJob(mode: "research" | "forward" | "archive" | "corporate"): Promise<void> {
  if (running) throw new Error("A strategy job is already running");
  running = mode;
  lastJob = { mode, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(directory, { recursive: true });
    // Exclusive file creation also serializes API and separate engine processes.
    lock = await open(path.join(directory, "worker.lock"), "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode }));
    if (mode === "corporate") {
      await pythonScript("backend/ai_service/nse_corporate_archive.py", ["--directory", archiveDirectory]);
      return;
    }
    if (mode === "archive") {
      await pythonScript("backend/ai_service/nse_archive.py", ["--directory", archiveDirectory]);
      try { await pythonScript("backend/ai_service/nse_corporate_archive.py", ["--directory", archiveDirectory]); }
      finally {
        const report = await readStrategyReport();
        if (report) {
          try {
            const spec = report.specification as { source_kind?: string; capital_inr: number };
            if (report.selected_strategy && spec.source_kind === "NSE_public_EOD_archives") {
              if (spec.capital_inr !== getConfig().tradingCapital) throw new Error("Configured capital differs from frozen research");
              const exchangeSource = path.join(directory, "exchange-candles.json");
              await pythonScript("backend/ai_service/nse_archive.py", ["--directory", archiveDirectory, "--export", exchangeSource]);
              await pythonScript("backend/ai_service/strategy_forward.py", ["--data", exchangeSource, "--directory", directory, "--archives", archiveDirectory]);
            }
          } finally {
            await pythonScript("backend/ai_service/strategy_verification.py", ["--directory", directory, "--archives", archiveDirectory]);
          }
        }
      }
      return;
    }
    const report = await readStrategyReport();
    if (mode === "forward" && report && (report.specification as { capital_inr: number }).capital_inr !== getConfig().tradingCapital) {
      throw new Error("Configured capital differs from the frozen research experiment");
    }
    const specification = report?.specification as { source_kind?: string } | undefined;
    let sourceKind = specification?.source_kind ?? "recorded_vendor_candles";
    if (mode === "research") {
      const backfill = await readExchangeBackfillStatus();
      sourceKind = backfill?.state === "completed_with_gaps" && Number(backfill.verified_sessions) >= 757
        && Array.isArray(backfill.invalid_reports) && backfill.invalid_reports.length === 0
        ? "NSE_public_EOD_archives" : "recorded_vendor_candles";
    }
    if (mode === "research" || report?.selected_strategy) {
      const dataSource = sourceKind === "NSE_public_EOD_archives" ? path.join(directory, "exchange-candles.json") : source;
      if (sourceKind === "NSE_public_EOD_archives") {
        if (mode === "forward") await pythonScript("backend/ai_service/nse_archive.py", ["--directory", archiveDirectory]);
        await pythonScript("backend/ai_service/nse_archive.py", ["--directory", archiveDirectory, "--export", dataSource]);
      } else {
        await pythonScript("backend/scripts/export_research_candles.py", ["--out", dataSource]);
      }
    }
    await pythonScript(`backend/ai_service/${mode === "research" ? "strategy_lab" : "strategy_forward"}.py`,
      ["--data", sourceKind === "NSE_public_EOD_archives" ? path.join(directory, "exchange-candles.json") : source,
        "--directory", directory, ...(mode === "research" ? ["--capital", String(getConfig().tradingCapital), "--risk-policy", "total_loss_budget", "--maximum-risk-pct", String(Math.min(1, getConfig().maxRiskPerTradePct)),
          ...(sourceKind === "NSE_public_EOD_archives" ? ["--corporate-archives", path.join(archiveDirectory, "historical_corporate")] : [])] : ["--archives", archiveDirectory])]);
    await pythonScript("backend/ai_service/strategy_verification.py", ["--directory", directory, "--archives", archiveDirectory]);
  } catch (error) {
    lastJob.error = (error as NodeJS.ErrnoException).code === "EEXIST"
      ? "Another worker holds the journal lock; stale locks require review" : "Strategy worker failed; data or configuration needs review";
    throw error;
  } finally {
    try { if (lock) { await lock.close(); await unlink(path.join(directory, "worker.lock")); } }
    finally { lastJob.finishedAt = new Date().toISOString(); running = null; }
  }
}

export async function readEtfRotationStudy(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(directory, "etf_rotation/latest.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function readEtfRotationSignal(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(directory, "etf_rotation/signal.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function runEtfSignalJob(capital?: number): Promise<Record<string, unknown>> {
  const cap = capital ?? getConfig().tradingCapital ?? 10_000;
  await pythonScript("backend/ai_service/etf_rotation_research.py", ["--signal", "--capital", String(cap)]);
  const sig = await readEtfRotationSignal();
  if (!sig) throw new Error("ETF rotation signal generation failed");
  return sig;
}
