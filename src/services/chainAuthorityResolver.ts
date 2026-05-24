/**
 * ChainAuthorityResolver — resolves chain Guardian membership for
 * coordinator permission checks.
 *
 * Modes:
 *   disabled — always returns isGuardian=false (safe default, no chain dep).
 *   rpc      — queries guardianMembership.members() via @polkadot/api WS RPC,
 *              caches the full member set with block metadata.
 *
 * Design notes:
 *   - The resolver is a singleton initialised at startup by createApp.ts.
 *   - Cache refresh is lazy (on next isGuardian call after TTL expiry) plus
 *     an optional eager background refresh.
 *   - If the RPC is unreachable, the last cached snapshot is returned with
 *     `stale: true`.  Callers decide whether to allow or deny on stale data.
 */

import type { CoordinatorConfig } from "../config/env.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type GuardianAuthoritySource = "chain-rpc" | "cache" | "disabled";

export interface GuardianAuthorityDecision {
  accountId: string;
  isGuardian: boolean;
  source: GuardianAuthoritySource;
  chainId: string;
  blockHash?: string;
  blockNumber?: string;
  observedAt: string;
  stale: boolean;
}

export interface GuardianAuthoritySnapshot {
  mode: "rpc" | "disabled";
  chainId: string;
  guardians: string[];
  blockHash?: string;
  blockNumber?: string;
  lastSyncAt?: string;
  stale: boolean;
  error?: string;
}

export interface ChainAuthorityResolver {
  isGuardian(accountId: string): Promise<GuardianAuthorityDecision>;
  listGuardians(): Promise<GuardianAuthoritySnapshot>;
  close(): Promise<void>;
}

// ─── Disabled resolver (no-op) ────────────────────────────────────────────────

class DisabledAuthorityResolver implements ChainAuthorityResolver {
  private readonly chainId: string;
  constructor(chainId: string) { this.chainId = chainId; }

  async isGuardian(accountId: string): Promise<GuardianAuthorityDecision> {
    return {
      accountId,
      isGuardian: false,
      source: "disabled",
      chainId: this.chainId,
      observedAt: new Date().toISOString(),
      stale: true,
    };
  }

  async listGuardians(): Promise<GuardianAuthoritySnapshot> {
    return { mode: "disabled", chainId: this.chainId, guardians: [], stale: true };
  }

  async close(): Promise<void> { /* no-op */ }
}

// ─── Cached snapshot ──────────────────────────────────────────────────────────

interface CachedSnapshot {
  members: Set<string>;
  blockHash: string;
  blockNumber: string;
  fetchedAt: number;
  error?: string;
}

// ─── RPC resolver ─────────────────────────────────────────────────────────────

class RpcAuthorityResolver implements ChainAuthorityResolver {
  private readonly rpcUrl: string;
  private readonly chainId: string;
  private readonly cacheTtlMs: number;
  private readonly maxStalenessBlocks: number;

  private cache: CachedSnapshot | null = null;
  private refreshInFlight: Promise<void> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private api: any | null = null;

  constructor(rpcUrl: string, chainId: string, cacheTtlMs: number, maxStalenessBlocks: number) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.cacheTtlMs = cacheTtlMs;
    this.maxStalenessBlocks = maxStalenessBlocks;
  }

  private async getApi(): Promise<unknown> {
    if (this.api) return this.api;
    const { ApiPromise, WsProvider } = await import("@polkadot/api");
    const provider = new WsProvider(this.rpcUrl);
    this.api = await ApiPromise.create({ provider });
    return this.api;
  }

  private isCacheFresh(): boolean {
    if (!this.cache) return false;
    return Date.now() - this.cache.fetchedAt < this.cacheTtlMs;
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = await this.getApi() as any;
      const header = await api.rpc.chain.getHeader();
      const blockNumber: string = header.number.toString();
      const blockHash: string = header.hash.toString();

      // Query guardianMembership.members() — returns a Vec<AccountId>
      const membersRaw = await api.query.guardianMembership.members();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const members: string[] = (membersRaw as any).map((id: any) => id.toString());

      this.cache = {
        members: new Set(members),
        blockHash,
        blockNumber,
        fetchedAt: Date.now(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (this.cache) {
        // Keep old data but mark as errored
        this.cache = { ...this.cache, error: errorMsg };
      } else {
        // No prior data; create an empty stale cache entry
        this.cache = {
          members: new Set(),
          blockHash: "",
          blockNumber: "0",
          fetchedAt: 0,
          error: errorMsg,
        };
      }
    }
  }

  private async ensureFresh(): Promise<void> {
    if (this.isCacheFresh()) return;
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    this.refreshInFlight = this.fetchSnapshot().finally(() => {
      this.refreshInFlight = null;
    });
    await this.refreshInFlight;
  }

  private isStale(): boolean {
    if (!this.cache) return true;
    return !this.isCacheFresh();
  }

  async isGuardian(accountId: string): Promise<GuardianAuthorityDecision> {
    await this.ensureFresh();
    const cache = this.cache;
    const now = new Date().toISOString();

    if (!cache) {
      return {
        accountId,
        isGuardian: false,
        source: "chain-rpc",
        chainId: this.chainId,
        observedAt: now,
        stale: true,
      };
    }

    return {
      accountId,
      isGuardian: cache.members.has(accountId),
      source: this.isCacheFresh() ? "chain-rpc" : "cache",
      chainId: this.chainId,
      blockHash: cache.blockHash || undefined,
      blockNumber: cache.blockNumber || undefined,
      observedAt: now,
      stale: this.isStale(),
    };
  }

  async listGuardians(): Promise<GuardianAuthoritySnapshot> {
    await this.ensureFresh();
    const cache = this.cache;
    const stale = this.isStale();

    return {
      mode: "rpc",
      chainId: this.chainId,
      guardians: cache ? [...cache.members] : [],
      blockHash: cache?.blockHash || undefined,
      blockNumber: cache?.blockNumber || undefined,
      lastSyncAt: cache && cache.fetchedAt > 0 ? new Date(cache.fetchedAt).toISOString() : undefined,
      stale,
      error: cache?.error,
    };
  }

  async close(): Promise<void> {
    if (this.api) {
      try { await this.api.disconnect(); } catch { /* ignore */ }
      this.api = null;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** A no-op resolver for internal system dispatches (schedulers, indexer sync)
 *  that never require Guardian authority. */
export const noopAuthorityResolver: ChainAuthorityResolver = new DisabledAuthorityResolver("none");

export function createChainAuthorityResolver(config: CoordinatorConfig): ChainAuthorityResolver {
  if (config.chainAuthorityMode === "rpc") {
    return new RpcAuthorityResolver(
      config.chainAuthorityRpcUrl,
      config.chainAuthorityChainId,
      config.chainAuthorityCacheTtlMs,
      config.chainAuthorityMaxStalenessBlocks,
    );
  }
  return new DisabledAuthorityResolver(config.chainAuthorityChainId);
}
