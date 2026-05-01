import type { FastifyPluginAsync } from "fastify";
import { GUARDIAN_REQUEST } from "../../db/projectionKinds.js";
import { okList } from "../../domain/apiTypes.js";
import { listEnvelope } from "../../domain/schemas.js";

interface GuardianRequest {
  id: string;
  projectId?: string;
  actionId?: string;
  status?: string;
}

const guardianRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string; actionId?: string; status?: string; limit?: string; cursor?: string } }>("/guardian-requests", {
    schema: {
      tags: ["Guardian"],
      summary: "List guardian requests",
      querystring: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          actionId: { type: "string" },
          status: { type: "string" },
          limit: { type: "string" },
          cursor: { type: "string" },
        },
      },
      response: { 200: listEnvelope() },
    },
  }, async (request) => {
    const { projectId, actionId, status, limit: limitStr, cursor } = request.query;
    const limit = Math.min(Number(limitStr) || 50, 200);
    let requests = fastify.coordinatorStore.listProjections<GuardianRequest>(GUARDIAN_REQUEST);
    if (projectId) requests = requests.filter((guardianRequest) => guardianRequest.projectId === projectId);
    if (actionId) requests = requests.filter((guardianRequest) => guardianRequest.actionId === actionId);
    if (status) requests = requests.filter((guardianRequest) => guardianRequest.status === status);
    let startIdx = 0;
    if (cursor) {
      const idx = requests.findIndex((guardianRequest) => guardianRequest.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page = requests.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
    return okList(page, { limit, nextCursor });
  });
};

export default guardianRoutes;
