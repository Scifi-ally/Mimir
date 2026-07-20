import { EventEmitter } from "node:events";
import type { InternalEvents } from "./types";

// HIGH FIX (Issue #13): Implement proper cleanup to prevent memory leaks
// Store original handlers to enable proper cleanup
type EventName = keyof InternalEvents;
type Handler<K extends EventName> = (payload: InternalEvents[K]) => void | Promise<void>;

class InternalEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });
  // Per-event map from the caller's handler to the wrapper we registered.
  // Keyed by event first: the SAME handler reference can legitimately be
  // subscribed to multiple events (or the same event twice). A single
  // WeakMap<handler, wrapper> collapsed all of those to one wrapper, so the
  // earlier unsubscribe() calls detached the wrong wrapper and silently leaked
  // listeners. A per-event WeakMap keeps every (event, handler) wrapper distinct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlerMaps = new Map<EventName, WeakMap<(...args: any[]) => any, (...args: any[]) => void>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private errorHandlers: Set<(...args: any[]) => void> = new Set();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish<K extends EventName>(event: K, payload: InternalEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  subscribe<K extends EventName>(event: K, handler: Handler<K>): () => void {
    const wrapped = (payload: InternalEvents[K]) => {
      void Promise.resolve(handler(payload)).catch((err) => {
        this.emitter.emit("error", err);
      });
    };

    // Store mapping per event for correct cleanup even when one handler
    // reference is bound to several events.
    let map = this.handlerMaps.get(event);
    if (!map) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map = new WeakMap<(...args: any[]) => any, (...args: any[]) => void>();
      this.handlerMaps.set(event, map);
    }
    map.set(handler, wrapped);
    this.emitter.on(event, wrapped);

    let detached = false;
    return () => {
      // Guard against double-unsubscribe detaching a later re-subscription.
      if (detached) return;
      detached = true;
      this.emitter.off(event, wrapped as (...args: unknown[]) => void);
      this.handlerMaps.get(event)?.delete(handler);
    };
  }

  onError(handler: (err: unknown) => void): () => void {
    this.errorHandlers.add(handler);
    this.emitter.on("error", handler);
    return () => {
      this.errorHandlers.delete(handler);
      this.emitter.off("error", handler);
    };
  }
  
  // HIGH FIX (Issue #13): Add cleanup method for error handlers
  clearErrorHandlers(): void {
    for (const handler of this.errorHandlers) {
      this.emitter.off("error", handler);
    }
    this.errorHandlers.clear();
  }
}

export const intelligenceBus = new InternalEventBus();
