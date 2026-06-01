import EventEmitter from "node:events";
import type { EventEnvelope } from "@vibly-ai/concord-foundation";
import type { Logger } from "../config/logger.js";
import type postgres from "postgres";

export interface EventMetadata {
  streamId?: number;
}

export type EventHandler = (event: EventEnvelope<string, unknown>, metadata?: EventMetadata) => void;
export type EventFilter = (event: EventEnvelope<string, unknown>) => boolean;
export type Unsubscribe = () => void;

const NOTIFY_CHANNEL = "coordinator_bus";

export interface EventBus {
  publish(event: EventEnvelope<string, unknown>): void;
  subscribe(handler: EventHandler, filter?: EventFilter): Unsubscribe;
  /** When backed by Postgres, replay missed events after reconnect (SSE Last-Event-ID). */
  replaySince?(sinceId: number, handler: EventHandler): Promise<void>;
  close?(): Promise<void>;
}

const EVENT_NAME = "event";

/** In-process bus for tests and `memory`/`sqlite` dev topologies. */
export function createInMemoryEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(500);

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

export function createEventBus(): EventBus {
  return createInMemoryEventBus();
}

export interface PostgresEventBusOptions {
  sql: postgres.Sql;
  logger: Logger;
}

/** LISTEN/NOTIFY + `coordinator_broadcast_events` for multi-instance SSE. */
export function createPostgresEventBus(opts: PostgresEventBusOptions): EventBus {
  const { sql, logger } = opts;
  const handlers = new Set<{ h: EventHandler; f?: EventFilter }>();

  const dispatch = async (payload: string | undefined): Promise<void> => {
    const id = Number(payload);
    if (!Number.isFinite(id)) return;
    const rows = await sql<{ id: number; envelope_json: string }[]>`
      select id, envelope_json from coordinator_broadcast_events where id = ${id}
    `;
    const row = rows[0];
    if (!row) return;
    let env: EventEnvelope<string, unknown>;
    try {
      env = JSON.parse(row.envelope_json) as EventEnvelope<string, unknown>;
    } catch (err) {
      logger.error(err, "failed to parse coordinator_broadcast_events row");
      return;
    }
    for (const { h, f } of handlers) {
      try {
        if (!f || f(env)) h(env, { streamId: row.id });
      } catch (err) {
        logger.error(err, "event bus handler error");
      }
    }
  };

  const listenPromise = sql.listen(NOTIFY_CHANNEL, (payload) => {
    void dispatch(payload);
  });

  return {
    publish(event) {
      void (async () => {
        try {
          await listenPromise;
          const json = JSON.stringify(event);
          const rows = await sql<{ id: number }[]>`
            insert into coordinator_broadcast_events (envelope_json) values (${json}) returning id
          `;
          const id = rows[0]?.id;
          if (id === undefined) return;
          await sql.notify(NOTIFY_CHANNEL, String(id));
        } catch (err) {
          logger.error(err, "Postgres event publish failed");
        }
      })();
    },
    subscribe(handler, filter) {
      const entry = { h: handler, f: filter };
      handlers.add(entry);
      return () => handlers.delete(entry);
    },
    async replaySince(sinceId, handler) {
      const rows = await sql<{ id: number; envelope_json: string }[]>`
        select id, envelope_json from coordinator_broadcast_events
        where id > ${sinceId}
        order by id asc
        limit 500
      `;
      for (const row of rows) {
        const env = JSON.parse(row.envelope_json) as EventEnvelope<string, unknown>;
        handler(env, { streamId: row.id });
      }
    },
    async close() {
      const meta = await listenPromise;
      await meta.unlisten();
    },
  };
}
