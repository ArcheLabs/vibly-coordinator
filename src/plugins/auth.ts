import fp from "fastify-plugin";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../config/env.js";
import { unauthorized } from "../domain/errors.js";
import { getRouteAuthPolicy } from "./authPolicy.js";

const PUBLIC_PATHS = new Set(["/health", "/ready", "/metrics", "/docs", "/openapi.json", "/documentation", "/version-policy"]);

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith("/docs/") || path.startsWith("/documentation/")) return true;
  return false;
}

export interface CoordinatorAuth {
  kind: "none" | "static" | "oidc";
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

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { config } = opts;

  if (config.apiAuthMode === "none") return;

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? "";

    if (isPublicPath(path) || getRouteAuthPolicy(request) === "public-read") return;

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
