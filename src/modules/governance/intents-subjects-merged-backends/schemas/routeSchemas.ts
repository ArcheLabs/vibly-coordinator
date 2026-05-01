import { envelope, envelopeKey, envelopeKeyArray, errorEnvelope } from "../../../../domain/schemas.js";

export const governanceRouteSchemas = {
  postCreateIntent: {
    tags: ["Governance"],
    summary: "Create a governance intent",
    body: {
      type: "object",
      required: ["kind", "title"],
      properties: {
        projectId: { type: "string" },
        kind: { type: "string" },
        actionId: { type: "string" },
        decisionRecordId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
    },
    response: { 200: envelopeKey("governanceIntent") },
  },
  postSubmitOpenGov: {
    tags: ["Governance"],
    summary: "Submit a governance intent through the Substrate OpenGov action path",
    params: {
      type: "object",
      required: ["governanceIntentId"],
      properties: { governanceIntentId: { type: "string" } },
    },
    body: {
      type: "object",
      required: ["actor"],
      properties: {
        actor: { type: "string" },
        payload: {},
        submitArgs: {},
        externalId: { type: "string" },
        subjectId: { type: "string" },
        metadata: { type: "object" },
      },
    },
    response: { 200: envelope() },
  },
  getIntent: {
    tags: ["Governance"],
    summary: "Get a governance intent",
    params: {
      type: "object",
      required: ["governanceIntentId"],
      properties: { governanceIntentId: { type: "string" } },
    },
    response: { 200: envelopeKey("governanceIntent") },
  },
  postSubmitMock: {
    tags: ["Governance"],
    summary: "Mock submit governance intent (MockGovernanceGateway)",
    params: {
      type: "object",
      required: ["governanceIntentId"],
      properties: { governanceIntentId: { type: "string" } },
    },
    response: { 200: envelope() },
  },
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
  postLinkSubject: {
    tags: ["Governance"],
    summary: "Link a governance intent to an on-chain subject",
    params: {
      type: "object",
      required: ["governanceIntentId"],
      properties: { governanceIntentId: { type: "string" } },
    },
    body: {
      type: "object",
      required: ["subjectId"],
      properties: {
        subjectId: { type: "string" },
        externalId: { type: "string" },
        backend: { type: "string" },
        linkSource: {
          type: "string",
          enum: ["explicit", "tx_receipt", "metadata_match", "manual"],
          default: "explicit",
        },
        confidence: { type: "string", enum: ["high", "medium", "low"], default: "high" },
        metadata: { type: "object" },
      },
    },
    response: { 200: envelopeKey("link") },
  },
  postReconcileSubject: {
    tags: ["Governance"],
    summary: "Reconcile a submitted governance intent with an indexed OpenGov subject",
    params: {
      type: "object",
      required: ["governanceIntentId"],
      properties: { governanceIntentId: { type: "string" } },
    },
    body: {
      type: "object",
      properties: {
        subjectId: { type: "string" },
        externalId: { type: "string" },
        metadata: { type: "object" },
      },
    },
    response: { 200: envelope() },
  },
} as const;
