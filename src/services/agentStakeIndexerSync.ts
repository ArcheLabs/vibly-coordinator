import type { ActionIntentDispatcher } from "../application/actionIntentDispatcher.js";
import type { CoordinatorConfig } from "../config/env.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import type { AgentProfile } from "../contexts/identity/types.js";
import type { AgentStakeStatus } from "../contexts/stake/types.js";
import type { Concord } from "@concord/sdk";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "./eventBus.js";

type RawLedger = {
  id: string;
  chainId: string;
  identityId: string;
  agentId: string;
  fundingAccount?: string | null;
  activeAmount: string | number | bigint;
  unbondingAmount: string | number | bigint;
  status: string;
  unlockAtBlock?: string | number | bigint | null;
  releaseBlocked: boolean;
  releaseBlockReason?: string | null;
  updatedAtBlock?: string | number | bigint | null;
};

type GraphQlLedgerResponse = {
  data?: {
    agentStakeLedgers?: {
      nodes?: RawLedger[];
      items?: RawLedger[];
    } | RawLedger[];
  };
  errors?: Array<{ message?: string }>;
};

export function startAgentStakeIndexerSync(input: {
  config: CoordinatorConfig;
  dispatcher: ActionIntentDispatcher;
  store: CoordinatorStorePort;
  eventBus: EventBus;
  concord: Concord;
}): () => void {
  if (!input.config.substrateIndexerUrl || input.config.agentStakeSyncIntervalMs <= 0) return () => {};

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncAgentStakeLedgers(input);
    } catch (err) {
      console.error("[AgentStakeIndexerSync]", err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, input.config.agentStakeSyncIntervalMs);
  return () => clearInterval(timer);
}

async function syncAgentStakeLedgers(input: {
  config: CoordinatorConfig;
  dispatcher: ActionIntentDispatcher;
  store: CoordinatorStorePort;
  eventBus: EventBus;
  concord: Concord;
}): Promise<void> {
  const ledgers = await fetchAgentStakeLedgers(input.config.substrateIndexerUrl!);
  const profiles = await new IdentityRepository(input.store).listAgentProfiles();
  for (const ledger of ledgers) {
    const profile = findProfileForLedger(profiles, ledger);
    await input.dispatcher.dispatch(
      {
        type: "UpsertAgentStakeLedger",
        principalId: input.config.coordinatorId,
        payload: {
          chainId: ledger.chainId,
          identityId: ledger.identityId,
          chainAgentId: ledger.agentId,
          principalId: profile?.principalId,
          fundingAccount: ledger.fundingAccount ?? undefined,
          activeAmount: String(ledger.activeAmount ?? "0"),
          unbondingAmount: String(ledger.unbondingAmount ?? "0"),
          status: normalizeStakeStatus(ledger.status),
          unlockAtBlock: ledger.unlockAtBlock == null ? undefined : String(ledger.unlockAtBlock),
          releaseBlocked: Boolean(ledger.releaseBlocked),
          releaseBlockReason: ledger.releaseBlockReason ?? undefined,
          updatedAtBlock: ledger.updatedAtBlock == null ? undefined : String(ledger.updatedAtBlock),
        },
      },
      {
        store: input.store,
        eventBus: input.eventBus,
        concord: input.concord,
        config: input.config,
        principalId: input.config.coordinatorId,
      },
    );
  }
}

async function fetchAgentStakeLedgers(indexerUrl: string): Promise<RawLedger[]> {
  const response = await fetch(indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query AgentStakeLedgers {
        agentStakeLedgers(first: 500, orderBy: UPDATED_AT_BLOCK_DESC) {
          nodes {
            id
            chainId
            identityId
            agentId
            fundingAccount
            activeAmount
            unbondingAmount
            status
            unlockAtBlock
            releaseBlocked
            releaseBlockReason
            updatedAtBlock
          }
        }
      }`,
    }),
  });
  if (!response.ok) throw new Error(`AgentStakeLedger GraphQL request failed: HTTP ${response.status}`);
  const body = await response.json() as GraphQlLedgerResponse;
  if (body.errors?.length) {
    throw new Error(`AgentStakeLedger GraphQL error: ${body.errors.map((err) => err.message ?? "unknown").join("; ")}`);
  }
  const value = body.data?.agentStakeLedgers;
  if (Array.isArray(value)) return value;
  return value?.nodes ?? value?.items ?? [];
}

function findProfileForLedger(profiles: AgentProfile[], ledger: RawLedger): AgentProfile | undefined {
  return profiles.find((profile) =>
    profile.chainId === ledger.chainId &&
    profile.identityId === ledger.identityId &&
    profile.chainAgentId === ledger.agentId,
  );
}

function normalizeStakeStatus(value: string): AgentStakeStatus {
  const normalized = value.toLowerCase();
  if (normalized === "active" || normalized === "unbonding" || normalized === "released") return normalized;
  return "missing";
}
