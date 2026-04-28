import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";

const stateRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /projects/:projectId/state/latest
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/state/latest",
    {
      schema: {
        tags: ["State"],
        summary: "Get latest state view for a project",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
      },
    },
    async (request) => {
      const stateView = await fastify.concord.state.projections.getLatestStateView();
      return ok({ stateView, projectId: request.params.projectId });
    },
  );

  // GET /state-views/:stateViewId
  fastify.get<{ Params: { stateViewId: string } }>(
    "/state-views/:stateViewId",
    {
      schema: {
        tags: ["State"],
        summary: "Get a state view",
        params: { type: "object", required: ["stateViewId"], properties: { stateViewId: { type: "string" } } },
      },
    },
    async (request) => {
      const stateView = await fastify.concord.state.projections.getStateView(request.params.stateViewId as never);
      if (!stateView) throw notFound("StateView", request.params.stateViewId);
      return ok({ stateView });
    },
  );

  // POST /projects/:projectId/state/rebuild — rebuild state from events
  fastify.post<{ Params: { projectId: string }; Body: { knowledgeVersionId: string } }>(
    "/projects/:projectId/state/rebuild",
    {
      schema: {
        tags: ["State"],
        summary: "Rebuild project state from events",
        params: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } },
        body: {
          type: "object",
          required: ["knowledgeVersionId"],
          properties: { knowledgeVersionId: { type: "string" } },
        },
      },
    },
    async (request) => {
      const stateView = await fastify.concord.state.refresh(request.body.knowledgeVersionId as never);
      return ok({ stateView });
    },
  );
};

export default stateRoutes;
