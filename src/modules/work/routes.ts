import type { FastifyPluginAsync } from "fastify";
import { ok, okList } from "../../domain/apiTypes.js";
import { notFound, badRequest } from "../../domain/errors.js";

const workRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /work-orders
  fastify.post<{
    Body: {
      actionId: string;
      goalId: string;
      projectId?: string;
      objectiveId?: string;
      title: string;
      description: string;
      contextBundleId: string;
      requiredCapabilities?: unknown[];
      reward?: unknown;
    };
  }>(
    "/work-orders",
    {
      schema: {
        tags: ["Work"],
        summary: "Create a work order",
        body: {
          type: "object",
          required: ["actionId", "goalId", "title", "description", "contextBundleId"],
          properties: {
            actionId: { type: "string" },
            goalId: { type: "string" },
            projectId: { type: "string" },
            objectiveId: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            contextBundleId: { type: "string" },
            requiredCapabilities: { type: "array" },
            reward: { type: "object" },
          },
        },
      },
    },
    async (request) => {
      const bundle = await fastify.concord.context.getBundle(request.body.contextBundleId);
      if (!bundle) throw notFound("ContextBundle", request.body.contextBundleId);

      const workOrder = await fastify.concord.work.createWorkOrder({
        actionId: request.body.actionId as never,
        goalId: request.body.goalId as never,
        projectId: request.body.projectId as never,
        objectiveId: request.body.objectiveId as never,
        title: request.body.title,
        description: request.body.description,
        contextBundleId: bundle.id,
        requiredCapabilities: (request.body.requiredCapabilities ?? []) as never,
        reward: request.body.reward as never,
      });
      fastify.eventBus.publish({ type: "WorkOrderCreated", payload: workOrder } as never);
      return ok({ workOrder });
    },
  );

  fastify.get<{ Querystring: { projectId?: string; status?: string; limit?: string; cursor?: string } }>(
    "/work-orders",
    {
      schema: {
        tags: ["Work"],
        summary: "List work orders",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            status: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const { projectId, status, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let orders = await fastify.concord.work.listWorkOrders();
      if (projectId) orders = orders.filter((o) => String((o as unknown as { projectId?: string }).projectId) === projectId);
      if (status) orders = orders.filter((o) => o.status === status);

      let startIdx = 0;
      if (cursor) {
        const idx = orders.findIndex((o) => o.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = orders.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /work-orders/open
  fastify.get<{ Querystring: { projectId?: string; limit?: string; cursor?: string } }>(
    "/work-orders/open",
    {
      schema: {
        tags: ["Work"],
        summary: "List open work orders",
        querystring: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const { projectId, limit: limitStr, cursor } = request.query;
      const limit = Math.min(Number(limitStr) || 50, 200);
      let orders = await fastify.concord.work.listOpenWorkOrders();
      if (projectId) orders = orders.filter((o) => String((o as unknown as { projectId?: string }).projectId) === projectId);

      let startIdx = 0;
      if (cursor) {
        const idx = orders.findIndex((o) => o.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page = orders.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit ? (page[page.length - 1]?.id ?? null) : null;
      return okList(page, { limit, nextCursor });
    },
  );

  // GET /work-orders/:workOrderId
  fastify.get<{ Params: { workOrderId: string } }>(
    "/work-orders/:workOrderId",
    {
      schema: {
        tags: ["Work"],
        summary: "Get a work order",
        params: { type: "object", required: ["workOrderId"], properties: { workOrderId: { type: "string" } } },
      },
    },
    async (request) => {
      const workOrder = await fastify.concord.work.getWorkOrder(request.params.workOrderId as never);
      if (!workOrder) throw notFound("WorkOrder", request.params.workOrderId);
      return ok({ workOrder });
    },
  );

  // POST /work-orders/:workOrderId/claim
  fastify.post<{
    Params: { workOrderId: string };
    Body: { actorId: string; leaseMs?: number };
  }>(
    "/work-orders/:workOrderId/claim",
    {
      schema: {
        tags: ["Work"],
        summary: "Claim a work order",
        params: { type: "object", required: ["workOrderId"], properties: { workOrderId: { type: "string" } } },
        body: {
          type: "object",
          required: ["actorId"],
          properties: {
            actorId: { type: "string" },
            leaseMs: { type: "number" },
          },
        },
      },
    },
    async (request) => {
      const claim = await fastify.concord.work.claim({
        actorId: request.body.actorId as never,
        workOrderId: request.params.workOrderId as never,
        leaseMs: request.body.leaseMs,
      });
      fastify.eventBus.publish({ type: "WorkOrderClaimed", payload: claim } as never);
      return ok({ claim });
    },
  );

  // POST /work-orders/:workOrderId/submit
  fastify.post<{
    Params: { workOrderId: string };
    Body: {
      submittedBy: string;
      projectId?: string;
      contextBundleId: string;
      artifacts?: unknown[];
      summary: string;
      executionReceipt?: unknown;
    };
  }>(
    "/work-orders/:workOrderId/submit",
    {
      schema: {
        tags: ["Work"],
        summary: "Submit work for a work order",
        params: { type: "object", required: ["workOrderId"], properties: { workOrderId: { type: "string" } } },
        body: {
          type: "object",
          required: ["submittedBy", "contextBundleId", "summary"],
          properties: {
            submittedBy: { type: "string" },
            projectId: { type: "string" },
            contextBundleId: { type: "string" },
            artifacts: { type: "array" },
            summary: { type: "string" },
            executionReceipt: { type: "object" },
          },
        },
      },
    },
    async (request) => {
      const bundle = await fastify.concord.context.getBundle(request.body.contextBundleId);
      if (!bundle) throw notFound("ContextBundle", request.body.contextBundleId);
      const { receiptFromBundle } = await import("@concord/adapters");
      const contextReceipt = receiptFromBundle(bundle, request.body.submittedBy as never);

      const submission = await fastify.concord.work.submit({
        workOrderId: request.params.workOrderId as never,
        submittedBy: request.body.submittedBy as never,
        artifacts: (request.body.artifacts ?? []) as never,
        summary: request.body.summary,
        contextReceipt,
        executionReceipt: request.body.executionReceipt as never,
      });
      fastify.eventBus.publish({ type: "WorkSubmitted", payload: submission } as never);
      return ok({ submission });
    },
  );

  // POST /work-orders/:workOrderId/cancel
  fastify.post<{
    Params: { workOrderId: string };
    Body: { reason: string };
  }>(
    "/work-orders/:workOrderId/cancel",
    {
      schema: {
        tags: ["Work"],
        summary: "Cancel a work order",
        params: { type: "object", required: ["workOrderId"], properties: { workOrderId: { type: "string" } } },
        body: {
          type: "object",
          required: ["reason"],
          properties: { reason: { type: "string" } },
        },
      },
    },
    async (request) => {
      await fastify.concord.work.expire({
        workOrderId: request.params.workOrderId as never,
        reason: request.body.reason,
      });
      fastify.eventBus.publish({ type: "WorkOrderCancelled", payload: { workOrderId: request.params.workOrderId, reason: request.body.reason } } as never);
      return ok({ cancelled: true });
    },
  );
};

export default workRoutes;
