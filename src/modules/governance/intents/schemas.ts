import { envelope, envelopeKey } from "../../../domain/schemas.js";

export const intentSchemas = {
  postCreate: {
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
