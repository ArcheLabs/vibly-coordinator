import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";
import { forbidden } from "../domain/errors.js";
import { getRouteAuthPolicy } from "./authPolicy.js";

function pathWithoutQuery(url: string): string {
  return url.split("?")[0] ?? url;
}

export interface AuthorizationPluginOptions {
  config: CoordinatorConfig;
}

const authorizationPlugin: FastifyPluginAsync<AuthorizationPluginOptions> = async (fastify, opts) => {
  const { config } = opts;

  fastify.addHook("preHandler", async (request) => {
    if (config.apiAuthMode === "none") return;

    const path = pathWithoutQuery(request.url);
    if (
      path === "/health" ||
      path === "/ready" ||
      path === "/metrics" ||
      path === "/openapi.json" ||
      path === "/version-policy" ||
      path === "/networks" ||
      path.startsWith("/networks/") ||
      path.startsWith("/docs") ||
      path.startsWith("/documentation")
    ) {
      return;
    }

    const policy = getRouteAuthPolicy(request);
    if (policy === "public-read") return;

    const auth = request.auth;
    if (!auth) throw forbidden("Auth context missing");
    if (policy === "wallet-session") {
      if (auth.kind === "none" && auth.scopes.includes("wallet-session")) return;
      if (auth.kind === "agent-runtime") return;
      throw forbidden("Wallet session is required for this endpoint");
    }

    if (auth.kind === "agent-runtime") {
      const segments = path.split("/").filter(Boolean);
      if (segments[0] === "agents" && segments[1] && segments[1] !== auth.subject) {
        throw forbidden("Agent runtime token cannot access a different agent");
      }
      if (request.method === "POST" && path === "/action-intents") return;
      throw forbidden("Agent runtime token is not allowed for this endpoint");
    }

    if (auth.kind === "static") return;

    throw forbidden("Unsupported auth context");
  });
};

export default fp(authorizationPlugin, { name: "authorization" });
