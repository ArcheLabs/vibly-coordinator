import { envelope, envelopeKey, envelopeKeyArray } from "../../../domain/schemas.js";

export const subjectSchemas = {
  listLegacyViews: {
    tags: ["Governance"],
    summary: "List governance subject views (from chain indexer)",
    response: { 200: envelopeKeyArray("items") },
  },
  getLegacyView: {
    tags: ["Governance"],
    summary: "Get a governance subject view by subjectId (chainId:referendumIndex)",
    params: {
      type: "object",
      required: ["subjectId"],
      properties: { subjectId: { type: "string" } },
    },
    response: { 200: envelopeKey("view") },
  },
  getCheckpoint: {
    tags: ["Governance"],
    summary: "Get the latest governance index checkpoint",
    response: { 200: envelope() },
  },
  listSubjects: {
    tags: ["Governance"],
    summary: "List governance subject views (typed projection)",
    querystring: {
      type: "object",
      properties: {
        chainId: { type: "string" },
        status: { type: "string" },
        backend: { type: "string" },
        limit: { type: "integer", default: 50 },
      },
    },
    response: { 200: envelopeKeyArray("items") },
  },
  getSubject: {
    tags: ["Governance"],
    summary: "Get a governance subject view by id",
    params: {
      type: "object",
      required: ["subjectId"],
      properties: { subjectId: { type: "string" } },
    },
    response: { 200: envelopeKey("subject") },
  },
  listSubjectVotes: {
    tags: ["Governance"],
    summary: "List vote activity for a governance subject",
    params: {
      type: "object",
      required: ["subjectId"],
      properties: { subjectId: { type: "string" } },
    },
    response: { 200: envelopeKeyArray("items") },
  },
  postVoteOpenGov: {
    tags: ["Governance"],
    summary: "Cast a Substrate OpenGov vote for an indexed governance subject",
    params: {
      type: "object",
      required: ["subjectId"],
      properties: { subjectId: { type: "string" } },
    },
    body: {
      type: "object",
      required: ["voter", "stance"],
      properties: {
        voter: { type: "string" },
        stance: { type: "string" },
        weight: { type: "string" },
        reason: { type: "string" },
        conviction: {},
        payload: {},
        metadata: { type: "object" },
      },
    },
    response: { 200: envelopeKey("receipt") },
  },
  listDelegations: {
    tags: ["Governance"],
    summary: "List governance delegation views",
    querystring: {
      type: "object",
      properties: {
        chainId: { type: "string" },
        limit: { type: "integer", default: 50 },
      },
    },
    response: { 200: envelopeKeyArray("items") },
  },
} as const;
