/**
 * Shared JSON Schema fragments for Fastify route response bodies.
 *
 * Goal: keep the wire envelope shape - `{ ok, data, page?, meta }` - in a
 * single place so that response declarations on each route are short and
 * stay in sync. We do not (yet) enumerate the full domain model in JSON
 * Schema - inner `data` payloads stay open via `additionalProperties: true`
 * unless a route explicitly tightens them.
 */

const META_SCHEMA = {
  type: "object" as const,
  properties: {
    requestId: { type: "string" as const },
  },
};

const PAGE_SCHEMA = {
  type: "object" as const,
  required: ["limit", "nextCursor"],
  properties: {
    limit: { type: "integer" as const },
    nextCursor: { type: ["string", "null"] as ("string" | "null")[] },
  },
};

const OPEN_OBJECT = { type: "object" as const, additionalProperties: true } as const;

/**
 * `{ ok: true, data: T, meta }` envelope where T is supplied by the caller
 * (either an open object or a tighter schema).
 */
export function envelope(dataSchema: object = OPEN_OBJECT) {
  return {
    type: "object" as const,
    required: ["ok", "data"],
    properties: {
      ok: { type: "boolean" as const, const: true },
      data: dataSchema,
      meta: META_SCHEMA,
    },
  };
}

/**
 * `{ ok: true, data: T, data: { key: T } }` convenience for routes that
 * wrap a single resource in `{ <key>: ... }` (like `data: { project }`).
 */
export function envelopeKey(key: string, valueSchema: object = OPEN_OBJECT) {
  return envelope({
    type: "object" as const,
    required: [key],
    properties: { [key]: valueSchema },
    additionalProperties: true,
  });
}

/** `{ ok, data: { [key]: T[] }, meta }` — use when the named field is an array (not a single object). */
export function envelopeKeyArray(key: string, itemSchema: object = OPEN_OBJECT) {
  return envelopeKey(key, { type: "array" as const, items: itemSchema });
}

/**
 * `{ ok: true, data: T[], page, meta }` list envelope.
 */
export function listEnvelope(itemSchema: object = OPEN_OBJECT) {
  return {
    type: "object" as const,
    required: ["ok", "data", "page"],
    properties: {
      ok: { type: "boolean" as const, const: true },
      data: { type: "array" as const, items: itemSchema },
      page: PAGE_SCHEMA,
      meta: META_SCHEMA,
    },
  };
}

export const errorEnvelope = {
  type: "object" as const,
  required: ["ok", "error"],
  properties: {
    ok: { type: "boolean" as const, const: false },
    error: {
      type: "object" as const,
      required: ["code", "message"],
      properties: {
        code: { type: "string" as const },
        message: { type: "string" as const },
        details: {},
      },
    },
    meta: META_SCHEMA,
  },
};
