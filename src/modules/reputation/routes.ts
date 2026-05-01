import type { FastifyPluginAsync } from "fastify";
import { REPUTATION_EVIDENCE } from "../../db/projectionKinds.js";
import { okList } from "../../domain/apiTypes.js";
import { listEnvelope } from "../../domain/schemas.js";

interface ReputationEvidence {
  id: string;
  projectId: string;
  actorId: string;
  kind: string;
}

const reputationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string; actorId?: string; kind?: string; limit?: string; cursor?: string } }>(
    "/reputation/evidence",
    {
      schema: {
        tags: ["Reputation"],
        summary: "List reputation evidence projections",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            actorId: { type: "string" },
            kind: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
    const { projectId, actorId, kind, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let items = await fastify.coordinatorStore.listProjections<ReputationEvidence>(REPUTATION_EVIDENCE);
    if (projectId) items = items.filter((item) => item.projectId === projectId);
    if (actorId) items = items.filter((item) => item.actorId === actorId);
    if (kind) items = items.filter((item) => item.kind === kind);
    let startIdx = 0;
    if (cursor) {
      const idx = items.findIndex((item) => item.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = items.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  },
  );
};

export default reputationRoutes;
