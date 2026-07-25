import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { logger } from "../lib/logger";

export type WorkerPoolName =
  | "candidate_detection"
  | "technical_analysis"
  | "ai_ranking"
  | "historical_loading";

interface PoolStats {
  name: WorkerPoolName;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  activeWorkers: number;
}

interface PendingTask {
  id: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reject: (reason: any) => void;
  enqueuedAt: number;
}

export class ThreadWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskQueue: PendingTask[] = [];
  private readonly pendingPromises = new Map<string, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (value: any) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reject: (reason: any) => void;
    task: PendingTask;
    worker: Worker;
  }>();

  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private consecutiveFailures = 0;
  private errors: string[] = [];
  private consecutiveFastExits = 0;

  private completed = 0;
  private failed = 0;
  private shuttingDown = false;
  // Workers whose replacement was already spawned (timeout path) — their
  // exit event must not spawn another.
  private readonly replacedWorkers = new Set<Worker>();

  constructor(
    public readonly name: WorkerPoolName,
    private readonly scriptPath: string,
    private readonly size: number,
    private maxQueueSize = 500,
    private readonly taskTimeoutMs = 10000,
  ) {
    this.init();
  }

  private init() {
    for (let i = 0; i < this.size; i++) {
      this.spawnWorker();
    }
  }

  private addError(msg: string) {
    this.errors.push(`${new Date().toISOString()}: ${msg}`);
    if (this.errors.length > 50) {
      this.errors.shift();
    }
  }

  private spawnWorker() {
    const spawnedAt = Date.now();
    const worker = new Worker(this.scriptPath, {
      workerData: { poolName: this.name },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.on("message", (msg: { id: string; success: boolean; result?: any; error?: string }) => {
      const pending = this.pendingPromises.get(msg.id);
      if (!pending) return;

      this.pendingPromises.delete(msg.id);
      this.makeWorkerIdle(worker);

      if (msg.success) {
        this.completed += 1;
        this.consecutiveFailures = 0;
        this.lastSuccessAt = Date.now();
        pending.resolve(msg.result);
      } else {
        this.failed += 1;
        this.consecutiveFailures += 1;
        this.lastFailureAt = Date.now();
        const errMsg = msg.error || "Unknown worker error";
        this.addError(errMsg);
        logger.warn({ error: msg.error, pool: this.name }, "Worker task execution failed");
        pending.reject(new Error(errMsg));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.on("error", (err: any) => {
      logger.error({ err, pool: this.name }, `Worker error inside pool ${this.name}`);
      this.consecutiveFailures += 1;
      this.lastFailureAt = Date.now();
      this.addError(err.message);
      // Find all tasks running on this worker and reject them
      for (const [id, pending] of this.pendingPromises.entries()) {
        if (pending.worker === worker) {
          this.pendingPromises.delete(id);
          this.failed += 1;
          pending.reject(err);
        }
      }
      this.removeWorker(worker);
      // No spawnWorker() here: terminate() fires the exit handler, which owns
      // respawning (with the fast-exit spawn-loop guard).
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        logger.warn({ code, pool: this.name }, `Worker exited with non-zero code ${code} in pool ${this.name}`);
        this.consecutiveFailures += 1;
        this.lastFailureAt = Date.now();
        this.addError(`Worker exited with code ${code}`);
      }

      // Fail any pending tasks running on this worker
      for (const [id, pending] of this.pendingPromises.entries()) {
        if (pending.worker === worker) {
          this.pendingPromises.delete(id);
          this.failed += 1;
          pending.reject(new Error(`Worker exited with code ${code}`));
        }
      }

      this.removeWorker(worker);
      // The timeout path already spawned this worker's replacement; spawning
      // again here would grow the pool by one thread per timeout, unbounded.
      if (this.replacedWorkers.delete(worker) || this.shuttingDown) return;

      // Guard against infinite spawn loops (broken worker script)
      const aliveMs = Date.now() - spawnedAt;
      if (aliveMs < 1000) {
        this.consecutiveFastExits += 1;
        if (this.consecutiveFastExits >= 5) {
          logger.error({ pool: this.name, consecutiveFastExits: this.consecutiveFastExits }, "Worker pool spawn loop detected — halting respawn. Fix the worker script.");
          this.addError("Spawn loop detected — respawn halted");
          return;
        }
        const delay = Math.min(30000, 2000 * Math.pow(2, this.consecutiveFastExits));
        logger.warn({ pool: this.name, aliveMs, delay }, "Worker died immediately after spawn — delaying respawn");
        setTimeout(() => this.spawnWorker(), delay);
      } else {
        this.consecutiveFastExits = 0;
        this.spawnWorker();
      }
    });

    this.workers.push(worker);
    this.idleWorkers.push(worker);
    this.drain();
  }

  setMaxQueueSize(newSize: number) {
    this.maxQueueSize = Math.max(10, newSize);
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
  enqueue<T>(type: string, payload: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.taskQueue.length >= this.maxQueueSize) {
        // Dynamic Backpressure: Reject new incoming tasks immediately so producer can backoff
        this.failed += 1;
        const err = new Error(`Worker pool '${this.name}' queue limit (${this.maxQueueSize}) reached. Backpressure applied: rejecting new task ${type}.`);
        this.addError(err.message);
        return reject(err);
      }

      const task: PendingTask = {
        id: crypto.randomUUID(),
        type,
        payload,
        resolve,
        reject,
        enqueuedAt: Date.now(),
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

      const timeoutTimer = setTimeout(() => {
        const pending = this.pendingPromises.get(task.id);
        if (!pending) return;

        this.pendingPromises.delete(task.id);
        this.failed += 1;
        this.consecutiveFailures += 1;
        this.lastFailureAt = Date.now();
        const err = new Error(`Worker task ${task.type} (${task.id}) timed out after ${this.taskTimeoutMs}ms`);
        this.addError(err.message);
        pending.reject(err);

        logger.error({ taskId: task.id, pool: this.name, type: task.type }, `Worker task timed out in pool ${this.name}. Terminating and respawning worker.`);

        this.replacedWorkers.add(worker);
        this.removeWorker(worker);
        this.spawnWorker();
      }, this.taskTimeoutMs);

      this.pendingPromises.set(task.id, {
        resolve: (value) => {
          clearTimeout(timeoutTimer);
          task.resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeoutTimer);
          task.reject(reason);
        },
        task,
        worker,
      });

      worker.postMessage({
        id: task.id,
        type: task.type,
        payload: task.payload,
      });
    }
  }

  stats(): PoolStats {
    return {
      name: this.name,
      queued: this.taskQueue.length,
      running: this.pendingPromises.size,
      completed: this.completed,
      failed: this.failed,
      activeWorkers: this.workers.length,
    };
  }

  getHealth() {
    const isHealthy = this.consecutiveFailures < 5 && this.workers.length === this.size;
    return {
      name: this.name,
      healthy: isHealthy,
      activeWorkers: this.workers.length,
      expectedWorkers: this.size,
      queuedTasks: this.taskQueue.length,
      runningTasks: this.pendingPromises.size,
      completedTasks: this.completed,
      failedTasks: this.failed,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      recentErrors: this.errors.slice(-5),
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const task of this.taskQueue) {
      task.reject(new Error(`Worker pool '${this.name}' shut down`));
    }
    this.taskQueue = [];
    for (const [, pending] of this.pendingPromises) {
      pending.reject(new Error(`Worker pool '${this.name}' shut down`));
    }
    this.pendingPromises.clear();
    const workers = this.workers;
    this.workers = [];
    this.idleWorkers = [];
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

// Resolve the path of the compiled worker script relative to the execution directory
const isEsm = typeof import.meta !== "undefined";
const dirname = globalThis.__dirname || (isEsm ? path.dirname(fileURLToPath(import.meta.url)) : __dirname);
const workerScriptPath = path.resolve(dirname, "intelligence/workers/intelligence_worker.mjs");

export const intelligenceWorkerPools = {
  candidateDetection: new ThreadWorkerPool("candidate_detection", workerScriptPath, 2, 500, 10000),
  technicalAnalysis: new ThreadWorkerPool("technical_analysis", workerScriptPath, 2, 200, 10000),
  aiRanking: new ThreadWorkerPool("ai_ranking", workerScriptPath, 1, 100, 15000),
  historicalLoading: new ThreadWorkerPool("historical_loading", workerScriptPath, 1, 50, 30000),
};

export function getWorkerPoolStats(): PoolStats[] {
  return Object.values(intelligenceWorkerPools).map((pool) => pool.stats());
}
