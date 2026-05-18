import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { envelopeKey } from "../../domain/schemas.js";
import { IdentityRepository } from "../../contexts/identity/repository.js";
import type { AgentProfile, AgentSessionKey } from "../../contexts/identity/types.js";
import { StakeRepository } from "../../contexts/stake/repository.js";
import type { AgentStakeLedger } from "../../contexts/stake/types.js";
import { IDENTITY_STATUS, normalizeEvmAddress, type IdentityStatusRecord } from "../../modules/identity/onboarding/domain.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../../modules/identity/wallet/domain.js";
import { AGENT_SECURITY_EVENT, AGENT_STAKE_RECEIPT, type AgentSecurityEvent } from "../../modules/identity/agent-enrollments/domain.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const OPEN_OBJECT = { type: "object" as const, additionalProperties: true };

function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  return Array.isArray(raw) ? raw[0] : raw;
}

const personalCenterRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/personal-center",
    {
      ...authPolicy("public-read", {
        tags: ["PersonalCenter"],
        summary: "Get the connected wallet personal center aggregate",
        response: { 200: envelopeKey("personalCenter", OPEN_OBJECT) },
      }),
    },
    async (request) => {
      const token = sessionTokenFromRequest(request.headers as Record<string, string | string[] | undefined>);
      const rawSession = token
        ? await fastify.coordinatorStore.getProjection<WalletSessionRecord>(WALLET_SESSION, token)
        : undefined;
      const session = token && rawSession ? ensureActiveWalletSession(rawSession, token) : null;
      const identityRepo = new IdentityRepository(fastify.coordinatorStore);
      const stakeRepo = new StakeRepository(fastify.coordinatorStore);

      const identity = session?.ecosystem === "evm"
        ? await fastify.coordinatorStore.getProjection<IdentityStatusRecord>(IDENTITY_STATUS, normalizeEvmAddress(session.address))
        : undefined;

      const allProfiles = await identityRepo.listAgentProfiles();
      const agents = session
        ? allProfiles.filter((profile) => isOwnedBySession(profile, session))
        : [];
      const ledgers = (await Promise.all(agents.map((agent) => stakeRepo.getLedgerForProfile(agent))))
        .filter((ledger): ledger is AgentStakeLedger => Boolean(ledger));
      const receipts = await fastify.coordinatorStore.listProjections<Record<string, unknown>>(AGENT_STAKE_RECEIPT);
      const securityEvents = (await fastify.coordinatorStore.listProjections<AgentSecurityEvent>(AGENT_SECURITY_EVENT))
        .filter((event) => !event.principalId || agents.some((agent) => agent.principalId === event.principalId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20);

      const alerts = buildAlerts({ identity, agents, ledgers });
      const stakeTotals = summarizeStake(ledgers);

      return ok({
        personalCenter: {
          session,
          identity: identity ?? null,
          agents: await Promise.all(agents.map(async (agent) => ({ ...agent, stakeLedger: await stakeRepo.getLedgerForProfile(agent) }))),
          stakeLedgers: ledgers,
          stakeReceipts: receipts.slice(0, 20),
          stakeTotals,
          alerts,
          securityEvents,
        },
      });
    },
  );
};

function isOwnedBySession(profile: AgentProfile, session: WalletSessionRecord): boolean {
  if (session.agentBindings.includes(profile.principalId)) return true;
  if (profile.evmAddress && session.ecosystem === "evm" && profile.evmAddress.toLowerCase() === session.address.toLowerCase()) return true;
  return (profile.sessionKeys ?? []).some((key) => key.authorizedBy === session.address);
}

function summarizeStake(ledgers: AgentStakeLedger[]) {
  return ledgers.reduce(
    (acc, ledger) => ({
      activeAmount: addDecimalStrings(acc.activeAmount, ledger.activeAmount),
      unbondingAmount: addDecimalStrings(acc.unbondingAmount, ledger.unbondingAmount),
      activeCount: acc.activeCount + (ledger.status === "active" ? 1 : 0),
      unbondingCount: acc.unbondingCount + (ledger.status === "unbonding" ? 1 : 0),
      releaseBlockedCount: acc.releaseBlockedCount + (ledger.releaseBlocked ? 1 : 0),
    }),
    { activeAmount: "0", unbondingAmount: "0", activeCount: 0, unbondingCount: 0, releaseBlockedCount: 0 },
  );
}

function addDecimalStrings(a: string, b: string): string {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return a;
  return String(left + right);
}

function buildAlerts(input: { identity?: IdentityStatusRecord; agents: AgentProfile[]; ledgers: AgentStakeLedger[] }) {
  const alerts: Array<Record<string, unknown>> = [];
  if (!input.identity) {
    alerts.push({ id: "identity-missing", severity: "warning", title: "Identity not linked", detail: "Connect or initialize a root identity before authorizing production agents." });
  }
  for (const agent of input.agents) {
    for (const key of agent.sessionKeys ?? []) {
      const expiring = isExpiringSoon(key);
      if (expiring) alerts.push({ id: `session-expiring:${key.id}`, severity: "warning", title: "Session key expires soon", detail: `${agent.displayName} expires soon.` });
      if (key.status === "revoked") alerts.push({ id: `session-revoked:${key.id}`, severity: "danger", title: "Session key revoked", detail: `${agent.displayName} has a revoked session key.` });
    }
  }
  for (const ledger of input.ledgers) {
    if (ledger.releaseBlocked) alerts.push({ id: `release-blocked:${ledger.id}`, severity: "danger", title: "Stake release blocked", detail: ledger.releaseBlockReason ?? ledger.id });
    if (ledger.status === "unbonding") alerts.push({ id: `unbonding:${ledger.id}`, severity: "warning", title: "Unbond pending", detail: `${ledger.chainAgentId} has ${ledger.unbondingAmount} pending unbond.` });
  }
  return alerts.slice(0, 20);
}

function isExpiringSoon(key: AgentSessionKey): boolean {
  if (!key.expiresAt) return false;
  const time = Date.parse(key.expiresAt);
  if (!Number.isFinite(time)) return false;
  return time - Date.now() <= 7 * 24 * 60 * 60 * 1000;
}

export default personalCenterRoutes;

