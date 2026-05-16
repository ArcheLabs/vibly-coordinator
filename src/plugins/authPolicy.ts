import type { FastifyRequest, FastifySchema } from "fastify";

export type AuthPolicy =
  | "public-read"
  | "wallet-session"
  | "signed-action"
  | "service-token"
  | "coordinator-authority";

declare module "fastify" {
  interface FastifyContextConfig {
    authPolicy?: AuthPolicy;
  }
}

const KNOWN_POLICIES = new Set<AuthPolicy>([
  "public-read",
  "wallet-session",
  "signed-action",
  "service-token",
  "coordinator-authority",
]);

export function authPolicy(policy: AuthPolicy, schema?: FastifySchema): { config: { authPolicy: AuthPolicy }; schema: FastifySchema } {
  return {
    config: { authPolicy: policy },
    schema: {
      ...(schema ?? {}),
      ...(policy === "public-read" ? { security: [] } : {}),
    },
  };
}

export function getRouteAuthPolicy(request: FastifyRequest): AuthPolicy | undefined {
  const value = (request.routeOptions.config as { authPolicy?: unknown } | undefined)?.authPolicy;
  if (typeof value !== "string") return undefined;
  if (!KNOWN_POLICIES.has(value as AuthPolicy)) return undefined;
  return value as AuthPolicy;
}
