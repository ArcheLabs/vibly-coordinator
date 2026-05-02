import { envelope, envelopeKeyArray, errorEnvelope } from "../../../domain/schemas.js";

export const backendSchemas = {
  listBackends: {
    tags: ["Governance"],
    summary: "List registered governance backends",
    response: { 200: envelopeKeyArray("backends") },
  },
  postSeedDemo: {
    tags: ["Governance"],
    summary: "Seed Phase D.5 demo governance projections (dev only)",
    response: { 200: envelope(), 403: errorEnvelope },
  },
} as const;
