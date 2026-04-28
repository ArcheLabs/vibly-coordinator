import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";
import { unauthorized } from "../domain/errors.js";

const PUBLIC_PATHS = new Set(["/health", "/docs", "/openapi.json", "/documentation"]);

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith("/docs/") || path.startsWith("/documentation/")) return true;
  return false;
}

export interface AuthPluginOptions {
  config: CoordinatorConfig;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { config } = opts;

  if (config.apiAuthMode === "none") return;

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const { url } = request;
    const path = url.split("?")[0];

    if (isPublicPath(path)) return;

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      const err = unauthorized("Missing or invalid Authorization header");
      return reply.code(401).send({
        ok: false,
        error: { code: err.code, message: err.message },
        meta: { requestId: `req_${Date.now()}` },
      });
    }

    const token = authHeader.slice(7).trim();
    if (!config.apiTokens.includes(token)) {
      const err = unauthorized("Invalid API token");
      return reply.code(401).send({
        ok: false,
        error: { code: err.code, message: err.message },
        meta: { requestId: `req_${Date.now()}` },
      });
    }
  });
};

export default fp(authPlugin, { name: "auth" });
