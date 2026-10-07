import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
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
  // Per-task deadline timers, cleared when a task settles.
  private readonly taskTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Deadline for a single worker task.
   *
   * The default was written as the string "60_000". Underscores are valid in a
   * TypeScript numeric literal but NOT in a string parsed by Number(), so this
   * evaluated to NaN, Math.max(5000, NaN) stayed NaN, and setTimeout(fn, NaN)
   * fires on the next tick - i.e. every task was killed instantly with
   * "timed out after NaNms" and the scanner could never make progress.
   *
   * Parse defensively: a bad or missing value must fall back to the real
   * default rather than silently disabling the deadline.
   */
  private readonly taskTimeoutMs = (() => {
    const raw = Number(process.env["SCAN_WORKER_TIMEOUT_MS"]);
    if (!Number.isFinite(raw) || raw <= 0) return 60_000;
    return Math.max(5_000, raw);
  })();
  private readonly size = Math.max(2, os.cpus().length - 1);
  private shuttingDown = false;
  // Observable counters, so a wedged-worker timeout is visible in telemetry
  // rather than a silent stall.
  private failed = 0;
  private readonly errors: string[] = [];

  private addError(message: string) {
    this.errors.push(message);
    if (this.errors.length > 50) this.errors.shift();
  }

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
      this.clearTaskTimer(msg.id);
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
          this.clearTaskTimer(id);
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
          this.clearTaskTimer(id);
          pending.reject(new Error(`Worker exited with code ${code}`));
        }
      }
      // Respawn only for UNEXPECTED exits (worker still registered). After an
      // "error" the error handler has already removed + respawned; terminate()
      // then fires this exit event, and respawning again here would grow the
      // pool by one thread per error, unbounded.
      const wasRegistered = this.workers.includes(worker);
      this.removeWorker(worker);
      if (wasRegistered && !this.shuttingDown) this.spawnWorker();
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

  private clearTaskTimer(taskId: string) {
    const timer = this.taskTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.taskTimers.delete(taskId);
    }
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
        tech.detectMatrixEnsembleSetup(dailyCandles, snap),
      ].filter((c): c is NonNullable<typeof c> => c !== null && (minRR == null || c.riskReward >= minRR));
      return { snap, allCandidates } as unknown as T;
    }
    return new Promise<T>((resolve, reject) => {
      // A task enqueued after shutdown() would sit in a queue with no workers to
      // drain it, and the rejection sweep below has already run — the returned
      // promise would never settle.
      if (this.shuttingDown) {
        return reject(new Error("Worker pool is shutting down; task rejected"));
      }
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

      // Per-task deadline. Without one, a worker that starts but never posts a
      // message (thread OOM, infinite loop in scan_worker, lost message) leaves
      // the entry in pendingPromises forever, so the returned promise never
      // settles AND a concurrency slot is permanently lost. Ten stuck tasks and
      // scanMarket makes zero progress while still holding every HTTP request
      // open — with no error and no log.
      const timer = setTimeout(() => {
        const pending = this.pendingPromises.get(task.id);
        if (!pending) return;
        this.pendingPromises.delete(task.id);
        this.taskTimers.delete(task.id);
        this.failed += 1;
        const err = new Error(`Scan worker task ${task.id} timed out after ${this.taskTimeoutMs}ms`);
        this.addError(err.message);
        pending.reject(err);
        // Replace the wedged worker so the pool keeps its concurrency budget.
        this.workers = this.workers.filter((w) => w !== worker);
        this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
        void worker.terminate().catch(() => {});
        this.spawnWorker();
      }, this.taskTimeoutMs);
      timer.unref?.();
      this.taskTimers.set(task.id, timer);

      worker.postMessage({
        id: task.id,
        payload: task.payload,
      });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // Cancel every in-flight deadline timer first, otherwise a timer armed
    // moments ago fires after shutdown and tries to respawn a worker into a pool
    // that is being torn down.
    for (const timer of this.taskTimers.values()) {
      clearTimeout(timer);
    }
    this.taskTimers.clear();
    // Reject queued tasks instead of silently dropping them — callers'
    // promises would otherwise hang forever.
    for (const task of this.taskQueue) {
      task.reject(new Error("Worker pool shut down"));
    }
    this.taskQueue = [];
    for (const [, pending] of this.pendingPromises) {
      pending.reject(new Error("Worker pool shut down"));
    }
    this.pendingPromises.clear();
    const workers = this.workers;
    this.workers = [];
    this.idleWorkers = [];
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

const isEsm = typeof import.meta !== "undefined";
const dirname = globalThis.__dirname || (isEsm ? path.dirname(fileURLToPath(import.meta.url)) : __dirname);

let workerScriptPath: string | URL;
if (process.env.NODE_ENV === "test" || process.env.VITEST) {
  workerScriptPath = new URL("./scan_worker.ts", import.meta.url);
} else {
  const candidates = [
    path.resolve(process.cwd(), "dist", "workers", "scan_worker.mjs"),
    path.resolve(process.cwd(), "backend", "dist", "workers", "scan_worker.mjs"),
    path.resolve(dirname, "workers", "scan_worker.mjs"),
    path.resolve(dirname, "..", "workers", "scan_worker.mjs"),
    path.resolve(dirname, "..", "..", "workers", "scan_worker.mjs"),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  workerScriptPath = found || path.resolve(process.cwd(), "dist", "workers", "scan_worker.mjs");
}

export const scanWorkerPool = new ScanWorkerPool(workerScriptPath);
