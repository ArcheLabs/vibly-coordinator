/**
 * GovernanceIndexConsumer
 *
 * Subscribes to the GovernanceIndexFeedPort (backed by SubQuery) and
 * writes normalized governance view projections to coordinatorStore.
 *
 * The consumer runs as a background loop. It is started by createApp
 * when `concord.governanceIndexFeed` is configured.
 */

import type { CoordinatorStore } from "../db/coordinatorStore.js";
import type { GovernanceIndexFeedPort } from "@concord/governance";
import type { ChainRef, NormalizedChainEvent } from "@concord/core";
import type { GovernanceEventType } from "@concord/governance";
import type { GovernanceProposalSummary } from "@concord/governance";

export interface GovernanceIndexConsumerOptions {
  store: CoordinatorStore;
  feed: GovernanceIndexFeedPort;
  chain: ChainRef;
  /** Abort signal to stop the consumer loop. */
  signal?: AbortSignal;
}

export class GovernanceIndexConsumer {
  private readonly opts: GovernanceIndexConsumerOptions;
  private running = false;

  constructor(opts: GovernanceIndexConsumerOptions) {
    this.opts = opts;
  }

  /** Start the consumer loop. Returns immediately (runs in background). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    const { store, feed, chain, signal } = this.opts;
    try {
      const events = feed.subscribeGovernanceEvents({ chain });
      for await (const event of events) {
        if (signal?.aborted) break;
        this.handleEvent(store, event);
      }
    } catch (err) {
      if (!this.opts.signal?.aborted) {
        console.error("[GovernanceIndexConsumer] stream error:", err);
      }
    } finally {
      this.running = false;
    }
  }

  private handleEvent(
    store: CoordinatorStore,
    event: NormalizedChainEvent<GovernanceEventType>,
  ): void {
    const payload = event.payload as GovernanceProposalSummary;
    if (!payload?.ref?.externalId) return;

    const key = `${event.chain.chainId ?? "unknown"}:${payload.ref.externalId}`;
    store.saveProjection("governance_view", key, {
      chainId: event.chain.chainId,
      externalId: payload.ref.externalId,
      title: payload.title,
      status: payload.status,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      metadata: payload.metadata,
      indexedAt: event.observedAt,
    });
  }
}
