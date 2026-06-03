import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";
import { notOk } from "../domain/apiTypes.js";
import { evaluateClientVersion, getVersionPolicy, readClientVersionHeaders } from "../modules/platform/version-policy/policy.js";

const VERSION_PUBLIC_PATHS = new Set(["/health", "/ready", "/metrics", "/docs", "/openapi.json", "/documentation", "/version-policy", "/networks"]);

export interface VersionPolicyPluginOptions {
  config: CoordinatorConfig;
}

function isPublicPath(path: string): boolean {
  if (VERSION_PUBLIC_PATHS.has(path)) return true;
  if (path === "/agent-enrollments/status") return true;
  if (path.startsWith("/networks/")) return true;
  if (path.startsWith("/docs/") || path.startsWith("/documentation/")) return true;
  return false;
}

const versionPolicyPlugin: FastifyPluginAsync<VersionPolicyPluginOptions> = async (fastify, opts) => {
  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? "";
    if (isPublicPath(path)) return;

    const result = evaluateClientVersion(getVersionPolicy(opts.config), readClientVersionHeaders(request));
    if (result.ok) return;

    return reply.code(426).send(notOk("UPGRADE_REQUIRED", result.reason, result.details, request.id));
  });
};

export default fp(versionPolicyPlugin, { name: "version-policy" });
