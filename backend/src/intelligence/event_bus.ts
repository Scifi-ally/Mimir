import { EventEmitter } from "node:events";
import type { InternalEvents } from "./types";

type EventName = keyof InternalEvents;
type Handler<K extends EventName> = (payload: InternalEvents[K]) => void | Promise<void>;

class InternalEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });

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
    this.emitter.on(event, wrapped);
    return () => this.emitter.off(event, wrapped);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError(handler: (err: any) => void): () => void {
    this.emitter.on("error", handler);
    return () => this.emitter.off("error", handler);
  }
}

export const intelligenceBus = new InternalEventBus();
