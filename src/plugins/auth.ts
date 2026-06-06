import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";
import { unauthorized } from "../domain/errors.js";
import { getRouteAuthPolicy } from "./authPolicy.js";
import {
  AGENT_RUNTIME_TOKEN,
  hashAgentRuntimeToken,
  isAgentRuntimeToken,
  timingSafeTokenHashEqual,
  type AgentRuntimeTokenRecord,
} from "../modules/identity/agent-enrollments/runtimeToken.js";

const PUBLIC_PATHS = new Set(["/health", "/ready", "/metrics", "/docs", "/openapi.json", "/documentation", "/version-policy", "/networks"]);

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith("/networks/")) return true;
  if (path.startsWith("/docs/") || path.startsWith("/documentation/")) return true;
  return false;
}

export interface CoordinatorAuth {
  kind: "none" | "static" | "agent-runtime";
  subject: string;
  scopes: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: CoordinatorAuth;
  }
}

export interface AuthPluginOptions {
  config: CoordinatorConfig;
}

function isAgentRuntimePathAllowed(request: FastifyRequest, path: string): boolean {
  if (request.method === "GET" && path === "/agent-stakes") return true;
  if (request.method === "GET" && path === "/events") return true;
  if (request.method === "POST" && path === "/action-intents") return true;
  if (path.startsWith("/agents/")) {
    const segments = path.split("/").filter(Boolean);
    return !segments[1] || segments[1] === request.auth?.subject;
  }
  if (request.method === "GET" && path.startsWith("/projects/") && path.endsWith("/stream")) return true;
  return false;
}

async function authenticateAgentRuntimeToken(request: FastifyRequest, token: string): Promise<boolean> {
  const tokenHash = hashAgentRuntimeToken(token);
  const records = await request.server.coordinatorStore.listProjections<AgentRuntimeTokenRecord>(AGENT_RUNTIME_TOKEN);
  const record = records.find((item) => timingSafeTokenHashEqual(item.tokenHash, tokenHash));
  if (!record || record.status !== "active") return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return false;
  const lastUsedAt = new Date().toISOString();
  await request.server.coordinatorStore.saveProjection(AGENT_RUNTIME_TOKEN, record.id, { ...record, lastUsedAt });
  request.auth = {
    kind: "agent-runtime",
    subject: record.principalId,
    scopes: ["agent:runtime"],
  };
  return true;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { config } = opts;

  if (config.apiAuthMode === "none") return;

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? "";
    const policy = getRouteAuthPolicy(request);

    if (isPublicPath(path) || policy === "public-read") return;

    if (policy === "wallet-session" && request.headers["x-wallet-session"]) {
      const raw = request.headers["x-wallet-session"];
      request.auth = {
        kind: "none",
        subject: Array.isArray(raw) ? raw[0] ?? "wallet-session" : String(raw),
        scopes: ["wallet-session"],
      };
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      const err = unauthorized("Missing or invalid Authorization header");
      return reply.code(401).send({
        ok: false,
        error: { code: err.code, message: err.message },
        meta: { requestId: request.id },
      });
    }

    const token = authHeader.slice(7).trim();

    if (isAgentRuntimeToken(token)) {
      const authenticated = await authenticateAgentRuntimeToken(request, token);
      if (!authenticated || !isAgentRuntimePathAllowed(request, path)) {
        const err = unauthorized("Invalid agent runtime token");
        return reply.code(401).send({
          ok: false,
          error: { code: err.code, message: err.message },
          meta: { requestId: request.id },
        });
      }
      return;
    }

    if (config.apiAuthMode === "static-token") {
      if (!config.apiTokens.includes(token)) {
        const err = unauthorized("Invalid API token");
        return reply.code(401).send({
          ok: false,
          error: { code: err.code, message: err.message },
          meta: { requestId: request.id },
        });
      }
      request.auth = {
        kind: "static",
        subject: "static-token",
        scopes: ["coord:admin"],
      };
      return;
    }
  });
};

export default fp(authPlugin, { name: "auth" });
