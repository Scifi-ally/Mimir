import { unpack } from "msgpackr";

/**
 * Off-Thread Market Data Processing Worker
 * Decouples raw string parsing and tick batching from the main UI browser thread.
 */

interface Tick {
  symbol: string;
  price?: number;
  ltp?: number;
  changePct?: number | null;
  change_pct?: number | null;
  volume?: number;
  bid?: number;
  ask?: number;
  timestamp?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const tickBatch = new Map<string, Tick>();
let batchTimer: ReturnType<typeof setInterval> | null = null;
let telemetryTimer: ReturnType<typeof setInterval> | null = null;
const WORKER_TICK_FLUSH_MS = 10;

let totalTicksReceived = 0;
let ticksThisSecond = 0;
let currentTicksPerSec = 0;
let queueHighWaterMark = 0;

const startTimers = () => {
  if (!batchTimer) {
    batchTimer = setInterval(flushTicks, WORKER_TICK_FLUSH_MS);
  }
  if (!telemetryTimer) {
    telemetryTimer = setInterval(() => {
      currentTicksPerSec = ticksThisSecond;
      ticksThisSecond = 0;
      self.postMessage({
        ok: true,
        msg: {
          event: "worker_telemetry",
          data: {
            ticksPerSec: currentTicksPerSec,
            totalTicksReceived,
            queueHighWaterMark,
            pendingBatchSize: tickBatch.size,
          },
        },
      });
      queueHighWaterMark = 0;
    }, 1000);
  }
};

const flushTicks = () => {
  if (tickBatch.size > 0) {
    const ticks = Array.from(tickBatch.values());
    self.postMessage({ ok: true, msg: { event: "tick_update", data: ticks } });
    tickBatch.clear();
  }
};

self.onmessage = (event: MessageEvent) => {
  const raw = event.data;
  startTimers();

  if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    try {
      const msg = unpack(new Uint8Array(raw));
      if (msg.event === "tick_update" && Array.isArray(msg.data)) {
        msg.data.forEach((tick: Tick) => processTick(tick));
      } else if (msg.channel === "market:tick") {
        processTick(msg.data || msg);
      } else {
        self.postMessage({ ok: true, msg });
      }
    } catch {
      self.postMessage({ ok: false, raw: "binary parse error" });
    }
    return;
  }

  // If already parsed object (e.g., from main thread batch transfer)
  if (typeof raw === "object" && raw !== null) {
    if (raw.type === "BATCH_TICKS" && Array.isArray(raw.ticks)) {
      raw.ticks.forEach((tick: Tick) => processTick(tick));
    }
    return;
  }

  if (typeof raw !== "string") return;

  try {
    const msg = JSON.parse(raw);
    if (msg.event === "tick_update" && Array.isArray(msg.data)) {
      msg.data.forEach((tick: Tick) => processTick(tick));
    } else if (msg.channel === "market:tick") {
      processTick(msg);
    } else {
      self.postMessage({ ok: true, msg });
    }
  } catch {
    self.postMessage({ ok: false, raw });
  }
};

function processTick(inputTick: unknown): void {
  let tick: Tick;
  if (Array.isArray(inputTick)) {
    // [symbol, ltp, volume, bid, ask, timestamp, change_pct]
    tick = {
      symbol: inputTick[0],
      ltp: inputTick[1],
      price: inputTick[1],
      volume: inputTick[2],
      bid: inputTick[3],
      ask: inputTick[4],
      timestamp: inputTick[5],
      change_pct: inputTick[6]
    };
  } else {
    tick = inputTick as Tick;
  }

  if (!tick || !tick.symbol) return;
  
  totalTicksReceived++;
  ticksThisSecond++;

  // Clean symbol name if prefixed
  const cleanSymbol = tick.symbol.split(":").pop() || tick.symbol;
  const rawPrice = tick.ltp ?? tick.price ?? 0;
  const ltp = Math.round(rawPrice * 100) / 100;

  const existing = tickBatch.get(cleanSymbol);
  const prevLtp = existing?.ltp ?? ltp;
  const direction = ltp > prevLtp ? "up" : ltp < prevLtp ? "down" : existing?.direction ?? "none";

  const merged: Tick = {
    ...existing,
    ...tick,
    symbol: cleanSymbol,
    ltp,
    price: ltp,
    change_pct: tick.change_pct ?? tick.changePct ?? existing?.change_pct ?? null,
    direction,
    timestamp: tick.timestamp ?? Date.now(),
  };

  tickBatch.set(cleanSymbol, merged);
  if (tickBatch.size > queueHighWaterMark) {
    queueHighWaterMark = tickBatch.size;
  }
}
