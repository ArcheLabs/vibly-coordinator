import type { FastifyPluginAsync } from "fastify";
import { SLASH_REQUEST } from "../../db/projectionKinds.js";
import { okList } from "../../domain/apiTypes.js";
import { listEnvelope } from "../../domain/schemas.js";

interface SlashRequest {
  id: string;
  projectId: string;
  actorId: string;
  status: string;
}

const riskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string; actorId?: string; status?: string; limit?: string; cursor?: string } }>(
    "/slash-requests",
    {
      schema: {
        tags: ["Risk"],
        summary: "List slash requests",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            actorId: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: { 200: listEnvelope() },
      },
    },
    async (request) => {
    const { projectId, actorId, status, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let items = await fastify.coordinatorStore.listProjections<SlashRequest>(SLASH_REQUEST);
    if (projectId) items = items.filter((item) => item.projectId === projectId);
    if (actorId) items = items.filter((item) => item.actorId === actorId);
    if (status) items = items.filter((item) => item.status === status);
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

export default riskRoutes;
