import type { FastifyRequest } from "fastify";
import type { CoordinatorConfig } from "../../../config/env.js";

export interface VersionPolicy {
  minimumClientVersion: string;
  recommendedClientVersion: string;
  minimumContractVersion: string;
  upgradeDeadline?: string;
  upgradeInstructionsUrl: string;
  protocolVersion: string;
  enforcement: boolean;
}

export interface ClientVersionHeaders {
  clientVersion?: string;
  contractVersion?: string;
  protocolVersion?: string;
  packageName?: string;
}

export function getVersionPolicy(config: CoordinatorConfig): VersionPolicy {
  return {
    minimumClientVersion: config.minimumClientVersion,
    recommendedClientVersion: config.recommendedClientVersion,
    minimumContractVersion: config.minimumContractVersion,
    upgradeDeadline: config.upgradeDeadline,
    upgradeInstructionsUrl: config.upgradeInstructionsUrl,
    protocolVersion: config.protocolVersion,
    enforcement: config.clientVersionEnforcement,
  };
}

export function readClientVersionHeaders(request: FastifyRequest): ClientVersionHeaders {
  return {
    clientVersion: readHeader(request, "x-vibly-client-version"),
    contractVersion: readHeader(request, "x-vibly-contract-version"),
    protocolVersion: readHeader(request, "x-vibly-protocol-version"),
    packageName: readHeader(request, "x-vibly-client-package"),
  };
}

export function evaluateClientVersion(policy: VersionPolicy, headers: ClientVersionHeaders): { ok: true } | { ok: false; reason: string; details: Record<string, unknown> } {
  if (!policy.enforcement) return { ok: true };
  if (!headers.clientVersion) {
    return { ok: false, reason: "Client version header is required", details: details(policy, headers) };
  }
  if (compareSemver(headers.clientVersion, policy.minimumClientVersion) < 0) {
    return { ok: false, reason: `Client version ${headers.clientVersion} is below the minimum ${policy.minimumClientVersion}`, details: details(policy, headers) };
  }
  if (headers.contractVersion && compareSemver(headers.contractVersion, policy.minimumContractVersion) < 0) {
    return { ok: false, reason: `Contract version ${headers.contractVersion} is below the minimum ${policy.minimumContractVersion}`, details: details(policy, headers) };
  }
  return { ok: true };
}

function details(policy: VersionPolicy, headers: ClientVersionHeaders): Record<string, unknown> {
  return {
    minimumClientVersion: policy.minimumClientVersion,
    recommendedClientVersion: policy.recommendedClientVersion,
    minimumContractVersion: policy.minimumContractVersion,
    upgradeDeadline: policy.upgradeDeadline,
    upgradeInstructionsUrl: policy.upgradeInstructionsUrl,
    protocolVersion: policy.protocolVersion,
    received: headers,
  };
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] {
  const clean = value.trim().replace(/^v/, "").split(/[+-]/)[0] ?? "";
  const parts = clean.split(".").map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
