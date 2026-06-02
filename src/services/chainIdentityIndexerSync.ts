import { decodeAddress } from "@polkadot/util-crypto";
import type { CoordinatorConfig } from "../config/env.js";
import { chainRootIdentityId, IdentityRepository } from "../contexts/identity/repository.js";
import type { ChainRootIdentity } from "../contexts/identity/types.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";

type RawChainIdentity = {
  id: string;
  chainId: string;
  identityId: string;
  owner: string;
  status: string;
  createdAtBlock?: string | number | bigint | null;
  updatedAtBlock?: string | number | bigint | null;
};

type GraphQlIdentityResponse = {
  data?: {
    chainIdentities?: {
      nodes?: RawChainIdentity[];
      items?: RawChainIdentity[];
    } | RawChainIdentity[];
  };
  errors?: Array<{ message?: string }>;
};

const PAGE_SIZE = 500;

export function startChainIdentityIndexerSync(input: {
  config: CoordinatorConfig;
  store: CoordinatorStorePort;
}): () => void {
  if (!input.config.substrateIndexerUrl || input.config.agentStakeSyncIntervalMs <= 0) return () => {};

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncChainRootIdentities(input.config, input.store);
    } catch (err) {
      console.error("[ChainIdentityIndexerSync]", err);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => { void tick(); }, input.config.agentStakeSyncIntervalMs);
  return () => clearInterval(timer);
}

export async function syncChainRootIdentities(config: CoordinatorConfig, store: CoordinatorStorePort): Promise<number> {
  if (!config.substrateIndexerUrl) return 0;
  const identities = await fetchChainIdentities(config.substrateIndexerUrl, config.substrateChainId);
  const repo = new IdentityRepository(store);
  const indexedAt = new Date().toISOString();
  for (const identity of identities) {
    const ownerAccountHex = normalizeSubstrateAccount(identity.owner);
    await repo.saveChainRootIdentity({
      id: chainRootIdentityId(identity.chainId, ownerAccountHex),
      chainId: identity.chainId,
      identityId: identity.identityId,
      ownerAddress: identity.owner,
      ownerAccountHex,
      status: normalizeIdentityStatus(identity.status),
      createdAtBlock: identity.createdAtBlock == null ? undefined : String(identity.createdAtBlock),
      updatedAtBlock: identity.updatedAtBlock == null ? undefined : String(identity.updatedAtBlock),
      indexedAt,
    });
  }
  return identities.length;
}

async function fetchChainIdentities(indexerUrl: string, chainId: string): Promise<RawChainIdentity[]> {
  const all: RawChainIdentity[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchChainIdentityPage(indexerUrl, chainId, offset, PAGE_SIZE);
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

async function fetchChainIdentityPage(indexerUrl: string, chainId: string, offset: number, first: number): Promise<RawChainIdentity[]> {
  const fetchOptions = {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ChainRootIdentities($first: Int!, $offset: Int!, $chainId: String!) {
        chainIdentities(first: $first, offset: $offset, filter: { chainId: { equalTo: $chainId } }, orderBy: UPDATED_AT_BLOCK_DESC) {
          nodes {
            id
            chainId
            identityId
            owner
            status
            createdAtBlock
            updatedAtBlock
          }
        }
      }`,
      variables: { first, offset, chainId },
    }),
  };
  let response: Response;
  try {
    response = await fetch(indexerUrl, fetchOptions);
  } catch {
    response = await fetch(indexerUrl, fetchOptions);
  }
  if (!response.ok) throw new Error(`ChainIdentity GraphQL request failed: HTTP ${response.status}`);
  const body = await response.json() as GraphQlIdentityResponse;
  if (body.errors?.length) {
    throw new Error(`ChainIdentity GraphQL error: ${body.errors.map((err) => err.message ?? "unknown").join("; ")}`);
  }
  const value = body.data?.chainIdentities;
  if (Array.isArray(value)) return value;
  return value?.nodes ?? value?.items ?? [];
}

export function normalizeSubstrateAccount(address: string): string {
  return `0x${Buffer.from(decodeAddress(address)).toString("hex")}`.toLowerCase();
}

function normalizeIdentityStatus(status: string): ChainRootIdentity["status"] {
  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized === "frozen" || normalized === "disabled") return normalized;
  return "unknown";
}
