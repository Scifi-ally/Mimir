import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { logger } from "../lib/logger";
import os from "node:os";

export class ScanWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private taskQueue: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly pendingPromises = new Map<string, any>();
  private readonly size = Math.max(2, os.cpus().length - 1);

  constructor(private readonly scriptPath: string | URL) {
    this.init();
  }

  private init() {
    if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
    for (let i = 0; i < this.size; i++) {
      this.spawnWorker();
    }
  }

  private spawnWorker() {
    const worker = new Worker(this.scriptPath, {
      execArgv: process.execArgv,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.on("message", (msg: { id: string; success: boolean; result?: any; error?: string }) => {
      const pending = this.pendingPromises.get(msg.id);
      if (!pending) return;

      this.pendingPromises.delete(msg.id);
      this.makeWorkerIdle(worker);

      if (msg.success) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || "Unknown worker error"));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.on("error", (err: any) => {
      logger.error({ err }, "Scan worker error");
      for (const [id, pending] of this.pendingPromises.entries()) {
        if (pending.worker === worker) {
          this.pendingPromises.delete(id);
          pending.reject(err);
        }
      }
      this.removeWorker(worker);
      this.spawnWorker();
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        logger.warn({ code }, `Scan worker exited with non-zero code ${code}`);
      }
      for (const [id, pending] of this.pendingPromises.entries()) {
        if (pending.worker === worker) {
          this.pendingPromises.delete(id);
          pending.reject(new Error(`Worker exited with code ${code}`));
        }
      }
      this.removeWorker(worker);
      this.spawnWorker();
    });

    this.workers.push(worker);
    this.idleWorkers.push(worker);
    this.drain();
  }

  private removeWorker(worker: Worker) {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
    void worker.terminate().catch(() => {});
  }

  private makeWorkerIdle(worker: Worker) {
    if (this.workers.includes(worker) && !this.idleWorkers.includes(worker)) {
      this.idleWorkers.push(worker);
    }
    this.drain();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async enqueue<T>(payload: any): Promise<T> {
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      const { dailyCandles, minRR } = payload;
      const tech = await import("../analysis/technical");
      const mr = await import("../analysis/mean_reversion_scanner");
      const rg = await import("../analysis/range_scanner");
      const snap = tech.buildSnapshot(dailyCandles);
      if (!snap) return { snap: null, allCandidates: [] } as unknown as T;
      const allCandidates = [
        tech.detectBreakout(dailyCandles, snap),
        tech.detectPullback(dailyCandles, snap),
        tech.detectMomentum(dailyCandles, snap),
        tech.detectEma9Reclaim(dailyCandles, snap),
        tech.detectBreakdown(dailyCandles, snap),
        tech.detectBearMomentum(dailyCandles, snap),
        tech.detectEma9Rejection(dailyCandles, snap),
        tech.detectMacdCrossover(dailyCandles, snap),
        tech.detectBollingerSqueezeBreakout(dailyCandles, snap),
        tech.detectLiquiditySweep(dailyCandles, snap),
        mr.detectMeanReversionLong(dailyCandles, snap),
        mr.detectMeanReversionShort(dailyCandles, snap),
        rg.detectRangeLong(dailyCandles, snap),
        rg.detectRangeShort(dailyCandles, snap),
      ].filter((c): c is NonNullable<typeof c> => c !== null && (minRR == null || c.riskReward >= minRR));
      return { snap, allCandidates } as unknown as T;
    }
    return new Promise<T>((resolve, reject) => {
      const task = {
        id: crypto.randomUUID(),
        payload,
        resolve,
        reject,
      };
      this.taskQueue.push(task);
      this.drain();
    });
  }

  private drain() {
    while (this.idleWorkers.length > 0 && this.taskQueue.length > 0) {
      const worker = this.idleWorkers.shift();
      const task = this.taskQueue.shift();
      if (!worker || !task) return;

      this.pendingPromises.set(task.id, {
        resolve: task.resolve,
        reject: task.reject,
        worker,
      });

      worker.postMessage({
        id: task.id,
        payload: task.payload,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.taskQueue = [];
    const promises = this.workers.map((w) => w.terminate());
    await Promise.all(promises);
    this.workers = [];
    this.idleWorkers = [];
    this.pendingPromises.clear();
  }
}

const isEsm = typeof import.meta !== "undefined";
const dirname = globalThis.__dirname || (isEsm ? path.dirname(fileURLToPath(import.meta.url)) : __dirname);

let workerScriptPath: string | URL;
if (process.env.NODE_ENV === "test" || process.env.VITEST) {
  workerScriptPath = new URL("./scan_worker.ts", import.meta.url);
} else if (dirname.includes("src" + path.sep + "workers") || dirname.includes("src/workers")) {
  // When running TS node directly, point to dist for actual worker execution
  workerScriptPath = path.resolve(process.cwd(), "dist", "workers", "scan_worker.mjs");
} else {
  // When running from bundled dist/api_server.mjs, dirname is dist
  workerScriptPath = path.resolve(dirname, "workers", "scan_worker.mjs");
}

export const scanWorkerPool = new ScanWorkerPool(workerScriptPath);
