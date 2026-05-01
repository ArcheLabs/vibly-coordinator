import type { FastifyPluginAsync } from "fastify";
import { SLASH_REQUEST } from "../../db/projectionKinds.js";
import { okList } from "../../domain/apiTypes.js";

interface SlashRequest {
  id: string;
  projectId: string;
  actorId: string;
  status: string;
}

const riskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string; actorId?: string; status?: string; limit?: string; cursor?: string } }>("/slash-requests", async (request) => {
    const { projectId, actorId, status, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let items = fastify.coordinatorStore.listProjections<SlashRequest>(SLASH_REQUEST);
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
  });
};

export default riskRoutes;
