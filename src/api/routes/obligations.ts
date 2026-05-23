/**
 * Obligations routes — list agent obligations (review / observation).
 * All obligation writes are driven by process managers.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { envelopeKeyArray } from "../../domain/schemas.js";
import { ObligationRepository } from "../../contexts/obligation/repository.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };

const obligationsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: {
      agentId?: string;
      kind?: string;
      status?: string;
      taskId?: string;
      limit?: number;
    };
  }>(
    "/obligations",
    {
      ...authPolicy("public-read", {
        tags: ["Obligations"],
        summary: "List agent obligations",
        querystring: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            kind: { type: "string" },
            status: { type: "string" },
            taskId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const repo = new ObligationRepository(fastify.coordinatorStore);
      const { agentId, kind, status, taskId, limit } = req.query;
      const items = await repo.list({
        agentId,
        kind: kind as "review" | "observation" | undefined,
        status: status as import("../../contexts/obligation/types.js").ObligationStatus | undefined,
        taskId,
      });
      return ok({ items: items.slice(0, limit ?? 50) });
    },
  );
};

export default obligationsRoutes;
