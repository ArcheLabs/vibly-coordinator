import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const AGENT_RUNTIME_TOKEN = "agent_runtime_token_v1";
export const AGENT_RUNTIME_TOKEN_PREFIX = "vibly_agent_rt_";

export interface AgentRuntimeTokenRecord {
  id: string;
  tokenHash: string;
  principalId: string;
  sessionKeyId: string;
  sessionPublicKey: string;
  authorizedBy: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export function createAgentRuntimeToken(): string {
  return `${AGENT_RUNTIME_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashAgentRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isAgentRuntimeToken(token: string): boolean {
  return token.startsWith(AGENT_RUNTIME_TOKEN_PREFIX);
}

export function timingSafeTokenHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
