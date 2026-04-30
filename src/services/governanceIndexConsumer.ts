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
import type { GovernanceProjectorService } from "./governanceProjector.js";
import {
  GOVERNANCE_SUBJECT_VIEW,
  GOVERNANCE_VOTE_ACTIVITY,
  GOVERNANCE_DELEGATION,
  GOVERNANCE_CHECKPOINT,
} from "../db/projectionKinds.js";

export interface GovernanceIndexConsumerOptions {
  store: CoordinatorStore;
  feed: GovernanceIndexFeedPort;
  chain: ChainRef;
  projector: GovernanceProjectorService;
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

  handleEvent(
    store: CoordinatorStore,
    event: NormalizedChainEvent<GovernanceEventType>,
  ): void {
    const { projector } = this.opts;
    const patches = projector.project(event);

    for (const patch of patches) {
      switch (patch.kind) {
        case "subject":
          store.saveProjection(GOVERNANCE_SUBJECT_VIEW, patch.id, patch.value);
          break;
        case "vote":
          store.saveProjection(GOVERNANCE_VOTE_ACTIVITY, patch.id, patch.value);
          break;
        case "delegation":
          store.saveProjection(GOVERNANCE_DELEGATION, patch.id, patch.value);
          break;
        case "checkpoint":
          store.saveProjection(GOVERNANCE_CHECKPOINT, patch.id, patch.value);
          break;
        case "link":
          // links are written via explicit POST /governance/intents/:id/link-subject
          break;
      }
    }

    // Backward-compat: also write the old governance_view format so Phase B
    // routes (/governance/views, /governance/checkpoint) continue to work.
    const payload = event.payload as GovernanceProposalSummary;
    if (payload?.ref?.externalId) {
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
}

