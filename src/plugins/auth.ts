import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
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

const PUBLIC_PATHS = new Set(["/health", "/ready", "/metrics", "/docs", "/openapi.json", "/documentation", "/version-policy"]);

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith("/docs/") || path.startsWith("/documentation/")) return true;
  return false;
}

export interface CoordinatorAuth {
  kind: "none" | "static" | "oidc" | "agent-runtime";
  subject: string;
  scopes: string[];
  projectIds: string[];
  email?: string;
  tenantId?: string;
  claims?: JWTPayload;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: CoordinatorAuth;
  }
}

export interface AuthPluginOptions {
  config: CoordinatorConfig;
}

let jwksCache: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(url: string) {
  if (!jwksCache || jwksCache.url !== url) {
    jwksCache = { url, jwks: createRemoteJWKSet(new URL(url)) };
  }
  return jwksCache.jwks;
}

function parseScopeClaim(payload: JWTPayload): string[] {
  const raw = payload["scope"];
  if (typeof raw === "string") return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

function parseProjectsClaim(payload: JWTPayload, claimName: string): string[] {
  const raw = payload[claimName];
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
    } catch {
      /* ignore */
    }
  }
  return [];
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
    projectIds: ["*"],
    claims: {
      principalId: record.principalId,
      sessionKeyId: record.sessionKeyId,
      sessionPublicKey: record.sessionPublicKey,
    },
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
        projectIds: [],
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
        projectIds: ["*"],
      };
      return;
    }

    // OIDC / JWT
    if (!config.oidcIssuer || !config.oidcAudience || !config.oidcJwksUrl) {
      const err = unauthorized("OIDC is not configured");
      return reply.code(500).send({
        ok: false,
        error: { code: err.code, message: err.message },
        meta: { requestId: request.id },
      });
    }

    try {
      const audiences = config.oidcAudience.split(",").map((s) => s.trim()).filter(Boolean);
      const { payload } = await jwtVerify(token, getJwks(config.oidcJwksUrl), {
        issuer: config.oidcIssuer,
        audience: audiences.length === 1 ? audiences[0] : audiences,
      });
      const sub = typeof payload.sub === "string" ? payload.sub : "";
      if (!sub) {
        const err = unauthorized("Token missing sub");
        return reply.code(401).send({
          ok: false,
          error: { code: err.code, message: err.message },
          meta: { requestId: request.id },
        });
      }
      const scopes = parseScopeClaim(payload);
      const projectIds = parseProjectsClaim(payload, config.oidcProjectsClaim);
      request.auth = {
        kind: "oidc",
        subject: sub,
        scopes,
        projectIds,
        email: typeof payload.email === "string" ? payload.email : undefined,
        tenantId: typeof payload["tenant_id"] === "string" ? (payload["tenant_id"] as string) : undefined,
        claims: payload,
      };
    } catch {
      const err = unauthorized("Invalid or expired JWT");
      return reply.code(401).send({
        ok: false,
        error: { code: err.code, message: err.message },
        meta: { requestId: request.id },
      });
    }
  });
};

export default fp(authPlugin, { name: "auth" });
