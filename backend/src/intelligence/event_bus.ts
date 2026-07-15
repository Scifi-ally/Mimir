import { EventEmitter } from "node:events";
import type { InternalEvents } from "./types";

// HIGH FIX (Issue #13): Implement proper cleanup to prevent memory leaks
// Store original handlers to enable proper cleanup
type EventName = keyof InternalEvents;
type Handler<K extends EventName> = (payload: InternalEvents[K]) => void | Promise<void>;

class InternalEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlerMap = new WeakMap<(...args: any[]) => any, (...args: any[]) => void>();
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
    
    // Store mapping for proper cleanup
    this.handlerMap.set(handler, wrapped);
    this.emitter.on(event, wrapped);
    
    return () => {
      const wrappedHandler = this.handlerMap.get(handler);
      if (wrappedHandler) {
        this.emitter.off(event, wrappedHandler as any);
      }
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError(handler: (err: any) => void): () => void {
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
