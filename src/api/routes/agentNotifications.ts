/**
 * Agent Notifications routes.
 * Agents poll GET /agents/:id/notifications?since=<seq>&limit=50
 * and acknowledge with POST /agents/:id/notifications/:notificationId/ack
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { NotificationRepository } from "../../contexts/notification/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };

const agentNotificationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Params: { id: string };
    Querystring: { since?: number; limit?: number };
  }>(
    "/agents/:id/notifications",
    {
      ...authPolicy("public-read", {
        tags: ["AgentNotifications"],
        summary: "List notifications for an agent since a sequence number",
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            since: { type: "integer" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const repo = new NotificationRepository(fastify.coordinatorStore);
      const items = await repo.listForAgent(req.params.id, req.query.since);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.post<{
    Params: { id: string; notificationId: string };
  }>(
    "/agents/:id/notifications/:notificationId/ack",
    {
      ...authPolicy("public-read", {
        tags: ["AgentNotifications"],
        summary: "Acknowledge a notification (idempotent)",
        params: {
          type: "object",
          required: ["id", "notificationId"],
          properties: {
            id: { type: "string" },
            notificationId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("notification") },
      }),
    },
    async (req) => {
      const repo = new NotificationRepository(fastify.coordinatorStore);
      const notification = await repo.get(req.params.notificationId);
      if (!notification) throw notFound("AgentNotification", req.params.notificationId);
      if (notification.status !== "acknowledged") {
        const updated = {
          ...notification,
          status: "acknowledged" as const,
          acknowledgedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await repo.save(updated);
        return ok({ notification: updated });
      }
      return ok({ notification });
    },
  );
};

export default agentNotificationsRoutes;
