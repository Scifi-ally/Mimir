import { logger } from "../lib/logger";
import { isMarketOpen } from "../market_data/market_state";

export type TickFeedMode = "full" | "throttled" | "paused";

export class AsyncAnalysisQueue<T> {
  private queue: T[] = [];
  private concurrency: number;
  private activeCount = 0;
  private processor: (item: T) => Promise<void>;
  private isProcessing = false;

  constructor(processor: (item: T) => Promise<void>, initialConcurrency: number = 2) {
    this.processor = processor;
    this.concurrency = initialConcurrency;
  }

  public setConcurrency(c: number) {
    this.concurrency = c;
    this.processQueue();
  }

  public push(item: T) {
    this.queue.push(item);
    this.processQueue();
  }

  public pushAll(items: T[]) {
    this.queue.push(...items);
    this.processQueue();
  }

  public get pendingCount() {
    return this.queue.length;
  }
  
  public get isActive() {
    return this.activeCount > 0 || this.queue.length > 0;
  }

  public async waitUntilEmpty(): Promise<void> {
    if (!this.isActive) return;
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (!this.isActive) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && this.activeCount < this.concurrency) {
        const item = this.queue.shift();
        if (!item) break;

        this.activeCount++;
        
        // Yield to event loop to allow WebSockets and other fast IO to process
        await new Promise(r => setImmediate(r));
        
        this.processor(item)
          .catch(err => {
            logger.warn({ err }, "AsyncAnalysisQueue processor failed for an item");
          })
          .finally(() => {
            this.activeCount--;
            this.processQueue(); // trigger next
          });
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

class LoadBalancer {
  private activeScans = 0;

  public beginScan() {
    this.activeScans++;
    logger.info({ activeScans: this.activeScans }, "Load Balancer: Scan started. Adjusting priorities.");
  }

  public endScan() {
    this.activeScans = Math.max(0, this.activeScans - 1);
    logger.info({ activeScans: this.activeScans }, "Load Balancer: Scan ended. Adjusting priorities.");
  }

  public get isScanning() {
    return this.activeScans > 0;
  }

  public getTickFeedMode(): TickFeedMode {
    if (this.activeScans > 0) {
      return isMarketOpen() ? "throttled" : "paused";
    }
    return "full";
  }

  public getScannerConcurrency(): number {
    if (isMarketOpen()) {
      return 2; // Slow down scan to let ticks process during market hours
    }
    return 10; // Max out Upstox API (10 req/sec) when market is closed
  }
}

export const loadBalancer = new LoadBalancer();
