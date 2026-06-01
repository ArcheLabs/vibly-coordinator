import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";
import { forbidden } from "../domain/errors.js";
import type { CoordinatorAuth } from "./auth.js";
import { getRouteAuthPolicy } from "./authPolicy.js";

export function requireScope(auth: CoordinatorAuth | undefined, scope: string): void {
  if (!auth) throw forbidden("Unauthorized");
  if (auth.scopes.includes("coord:admin")) return;
  if (auth.scopes.includes(scope)) return;
  throw forbidden(`Missing scope: ${scope}`);
}

function pathWithoutQuery(url: string): string {
  return url.split("?")[0] ?? url;
}

export interface AuthorizationPluginOptions {
  config: CoordinatorConfig;
}

const authorizationPlugin: FastifyPluginAsync<AuthorizationPluginOptions> = async (fastify, opts) => {
  const { config } = opts;

  fastify.addHook("preHandler", async (request) => {
    if (config.apiAuthMode !== "oidc") return;

    const path = pathWithoutQuery(request.url);
    if (
      path === "/health" ||
      path === "/ready" ||
      path === "/metrics" ||
      path === "/openapi.json" ||
      path.startsWith("/docs") ||
      path.startsWith("/documentation")
    ) {
      return;
    }

    const policy = getRouteAuthPolicy(request);
    if (policy === "public-read") return;

    const auth = request.auth;
    if (!auth) throw forbidden("Auth context missing");
    if (auth.kind === "static") return;
    if (auth.kind === "none" && policy === "wallet-session" && auth.scopes.includes("wallet-session")) return;

    if (auth.kind === "agent-runtime") {
      const segments = path.split("/").filter(Boolean);
      if (segments[0] === "agents" && segments[1] && segments[1] !== auth.subject) {
        throw forbidden("Agent runtime token cannot access a different agent");
      }
      if (policy === "wallet-session") return;
      if (request.method === "POST" && path === "/action-intents") return;
      throw forbidden("Agent runtime token is not allowed for this endpoint");
    }

    if (policy === "coordinator-authority") {
      requireScope(auth, "coord:admin");
      return;
    }

    if (policy === "service-token" || policy === "wallet-session" || policy === "signed-action") {
      const read = request.method === "GET" || request.method === "HEAD";
      requireScope(auth, read ? "coord:read" : "coord:write");
      return;
    }

    const m = request.method;
    const read = m === "GET" || m === "HEAD";

    if (path.startsWith("/governance")) {
      requireScope(auth, read ? "governance:read" : "governance:write");
      return;
    }

    if (path.startsWith("/projects/")) {
      const segments = path.split("/").filter(Boolean);
      const projectId = segments.length >= 2 && segments[0] === "projects" ? segments[1] : undefined;
      if (!projectId) {
        requireScope(auth, read ? "coord:read" : "coord:write");
        return;
      }
      const admin = auth.scopes.includes("coord:admin");
      const wildcard = auth.projectIds.includes("*");
      const allowed = admin || wildcard || auth.projectIds.includes(projectId);
      if (!allowed) throw forbidden(`No access to project ${projectId}`);
      requireScope(auth, read ? "coord:read" : "coord:write");
      return;
    }

    const needsCoord =
      path.startsWith("/work") ||
      path.startsWith("/reviews") ||
      path.startsWith("/incentives") ||
      path.startsWith("/guardian");
    if (needsCoord) {
      requireScope(auth, read ? "coord:read" : "coord:write");
    }
  });
};

export default fp(authorizationPlugin, { name: "authorization" });
