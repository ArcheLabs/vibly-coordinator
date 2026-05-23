/**
 * Tight JSON Schema fragments for the Public Library routes.
 *
 * Unlike internal read-model routes (which often use OPEN_OBJECT), these
 * schemas enumerate every field so that generated OpenAPI types are usable
 * in @vibly/coordinator-http-contract consumers without manual casting.
 */

export const CONTRIBUTOR_SCHEMA = {
  type: "object" as const,
  required: ["id", "name"] as string[],
  properties: {
    id: { type: "string" as const },
    name: { type: "string" as const },
    role: { type: "string" as const },
  },
  additionalProperties: false,
};

export const PUBLIC_ARTIFACT_SCHEMA = {
  type: "object" as const,
  required: [
    "id",
    "title",
    "slug",
    "summary",
    "markdown",
    "orgId",
    "orgSlug",
    "orgName",
    "type",
    "status",
    "order",
    "tags",
    "contributors",
    "reviewCount",
    "hotScore",
    "version",
    "sourceReviewRoundIds",
    "createdAt",
    "updatedAt",
    "publishedAt",
  ] as string[],
  properties: {
    id: { type: "string" as const },
    title: { type: "string" as const },
    slug: { type: "string" as const },
    summary: { type: "string" as const },
    markdown: { type: "string" as const },
    locale: { type: "string" as const },

    orgId: { type: "string" as const },
    orgSlug: { type: "string" as const },
    orgName: { type: "string" as const },

    projectId: { type: "string" as const },
    projectSlug: { type: "string" as const },
    projectName: { type: "string" as const },

    type: { type: "string" as const, enum: ["report", "spec", "note", "template"] as string[] },
    status: { type: "string" as const, enum: ["published", "verified", "updated"] as string[] },
    order: { type: "integer" as const },
    tags: { type: "array" as const, items: { type: "string" as const } },

    authorAgentId: { type: "string" as const },
    authorAgentName: { type: "string" as const },
    contributors: { type: "array" as const, items: CONTRIBUTOR_SCHEMA },

    reviewCount: { type: "integer" as const },
    hotScore: { type: "number" as const },
    version: { type: "integer" as const },

    sourceTaskId: { type: "string" as const },
    sourceDiscussionId: { type: "string" as const },
    sourceReviewRoundIds: { type: "array" as const, items: { type: "string" as const } },
    sourceKnowledgeEntryId: { type: "string" as const },

    createdAt: { type: "string" as const },
    updatedAt: { type: "string" as const },
    publishedAt: { type: "string" as const },
  },
  additionalProperties: false,
};

export const PUBLIC_ORG_SCHEMA = {
  type: "object" as const,
  required: ["id", "slug", "name", "description", "documentCount", "agentCount", "projectCount"] as string[],
  properties: {
    id: { type: "string" as const },
    slug: { type: "string" as const },
    name: { type: "string" as const },
    description: { type: "string" as const },
    documentCount: { type: "integer" as const },
    agentCount: { type: "integer" as const },
    projectCount: { type: "integer" as const },
  },
  additionalProperties: false,
};

export const PUBLIC_PROJECT_SCHEMA = {
  type: "object" as const,
  required: ["id", "slug", "name", "description", "orgId", "orgSlug", "orgName", "documentCount", "agentCount"] as string[],
  properties: {
    id: { type: "string" as const },
    slug: { type: "string" as const },
    name: { type: "string" as const },
    description: { type: "string" as const },
    orgId: { type: "string" as const },
    orgSlug: { type: "string" as const },
    orgName: { type: "string" as const },
    documentCount: { type: "integer" as const },
    agentCount: { type: "integer" as const },
  },
  additionalProperties: false,
};

export const PUBLIC_AGENT_SCHEMA = {
  type: "object" as const,
  required: ["id", "name", "reputation", "documentCount"] as string[],
  properties: {
    id: { type: "string" as const },
    name: { type: "string" as const },
    role: { type: "string" as const },
    description: { type: "string" as const },
    reputation: { type: "number" as const },
    documentCount: { type: "integer" as const },
    orgName: { type: "string" as const },
    orgSlug: { type: "string" as const },
  },
  additionalProperties: false,
};
