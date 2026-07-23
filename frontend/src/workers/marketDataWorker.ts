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
const WORKER_TICK_FLUSH_MS = 150;

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
    // [symbol, ltp, volume, bid, ask, timestamp, changePct]
    tick = {
      symbol: inputTick[0],
      ltp: inputTick[1],
      price: inputTick[1],
      volume: inputTick[2],
      bid: inputTick[3],
      ask: inputTick[4],
      timestamp: inputTick[5],
      changePct: inputTick[6]
    };
  } else {
    tick = inputTick as Tick;
  }

  if (!tick || !tick.symbol) return;
  
  totalTicksReceived++;
  ticksThisSecond++;

  let rawSym = tick.symbol.trim();
  if (rawSym.includes("|")) rawSym = rawSym.split("|").pop() || rawSym;
  if (rawSym.includes(":")) rawSym = rawSym.split(":").pop() || rawSym;
  const cleanSymbol = rawSym.replace(/-EQ$/, "").toUpperCase();
  const existing = tickBatch.get(cleanSymbol);

  // A tick may arrive carrying only a volume/bid/ask/change update and no price.
  // Previously we coerced a missing price to 0 (`tick.ltp ?? tick.price ?? 0`),
  // which then overwrote the last good price — the provider's `?? existing.ltp`
  // chain can't recover because 0 is not nullish — and the UI flashed ₹0.00 red
  // as if the stock had crashed. Carry the last known price instead; if we have
  // never seen a price for this symbol, drop the tick rather than publish a fake 0.
  const incomingPrice = tick.ltp ?? tick.price;
  const rawPrice = incomingPrice ?? existing?.ltp;
  if (rawPrice == null) return; // no price now and none previously — nothing to emit
  const ltp = Math.round(rawPrice * 100) / 100;

  const prevLtp = existing?.ltp ?? ltp;
  const direction = ltp > prevLtp ? "up" : ltp < prevLtp ? "down" : existing?.direction ?? "none";

  const incomingChangePct = tick.changePct ?? tick.changePct;
  const changePct = incomingChangePct != null ? incomingChangePct : (existing?.changePct ?? null);

  const merged: Tick = {
    ...existing,
    ...tick,
    symbol: cleanSymbol,
    ltp,
    price: ltp,
    changePct,
    direction,
    timestamp: tick.timestamp ?? Date.now(),
  };

  tickBatch.set(cleanSymbol, merged);
  if (tickBatch.size > queueHighWaterMark) {
    queueHighWaterMark = tickBatch.size;
  }
}
