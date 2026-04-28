import EventEmitter from "node:events";
import type { EventEnvelope } from "@concord/foundation";

export interface EventBus {
  publish(event: EventEnvelope<string, unknown>): void;
  subscribe(handler: EventHandler, filter?: EventFilter): Unsubscribe;
}

export type EventHandler = (event: EventEnvelope<string, unknown>) => void;
export type EventFilter = (event: EventEnvelope<string, unknown>) => boolean;
export type Unsubscribe = () => void;

const EVENT_NAME = "event";

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);

  return {
    publish(event) {
      emitter.emit(EVENT_NAME, event);
    },

    subscribe(handler, filter) {
      const wrapped: EventHandler = filter ? (e) => { if (filter(e)) handler(e); } : handler;
      emitter.on(EVENT_NAME, wrapped);
      return () => emitter.off(EVENT_NAME, wrapped);
    },
  };
}

// Re-export the raw emitter approach for SSE plugin compatibility
export function createRawEventEmitter() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  return emitter;
}
