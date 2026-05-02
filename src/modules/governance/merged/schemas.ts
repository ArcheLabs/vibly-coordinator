import { envelopeKey, envelopeKeyArray } from "../../../domain/schemas.js";

export const mergedSchemas = {
  listMerged: {
    tags: ["Governance"],
    summary: "List merged governance views (intent + subject + link)",
    querystring: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        backend: { type: "string" },
        limit: { type: "integer", default: 50 },
      },
    },
    response: { 200: envelopeKeyArray("items") },
  },
  getMergedDetail: {
    tags: ["Governance"],
    summary: "Get a single merged governance view",
    params: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    response: { 200: envelopeKey("merged") },
  },
} as const;
