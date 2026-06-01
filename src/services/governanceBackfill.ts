/**
 * GovernanceBackfillService
 *
 * Pulls all governance subjects from GovernanceIndexQueryPort and projects
 * them into the coordinator store via GovernanceProjectorService.
 *
 * Not exposed as a public HTTP endpoint. Used internally (and in tests)
 * to bootstrap projections from existing indexer data.
 */

import type { ChainRef } from "@vibly-ai/concord-core";
import type { GovernanceIndexQueryPort } from "@vibly-ai/concord-governance";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { GovernanceProjectorService } from "./governanceProjector.js";
import {
  GOVERNANCE_SUBJECT_VIEW,
  GOVERNANCE_CHECKPOINT,
} from "../db/projectionKinds.js";
import type { GovernanceCheckpointView } from "@vibly-ai/concord-governance";

export interface GovernanceBackfillInput {
  chain: ChainRef;
  /** Optional paging cursor for incremental backfill. */
  from?: string;
}

export interface GovernanceBackfillResult {
  projected: number;
  checkpoint?: GovernanceCheckpointView;
}

export class GovernanceBackfillService {
  private readonly projector: GovernanceProjectorService;

  constructor(
    private readonly indexQuery: GovernanceIndexQueryPort,
    private readonly store: CoordinatorStorePort,
    projector?: GovernanceProjectorService,
  ) {
    this.projector = projector ?? new GovernanceProjectorService();
  }

  /**
   * Pull all governance subjects from the indexer and project them into the
   * coordinator store. Returns the number of subjects projected.
   */
  async backfill(input: GovernanceBackfillInput): Promise<GovernanceBackfillResult> {
    const { chain, from } = input;
    let projected = 0;
    let cursor: string | undefined = from;
    const observedAt = new Date().toISOString();

    while (true) {
      const page = await this.indexQuery.listGovernanceSubjects({ chain, cursor, limit: 50 });

      for (const summary of page.items) {
        // Construct a synthetic event from the proposal summary
        const eventType =
          summary.status === "Submitted"
            ? "GovernanceProposalDiscovered" as const
            : "GovernanceProposalUpdated" as const;

        const event = {
          id: `backfill:${summary.ref.externalId}:${summary.status}`,
          chain,
          type: eventType,
          payload: summary,
          observedAt,
          finality: "finalized" as const,
        };

        const patches = this.projector.project(event);
        for (const patch of patches) {
          if (patch.kind === "subject") {
            await this.store.saveProjection(GOVERNANCE_SUBJECT_VIEW, patch.id, patch.value);
          }
          // Skip checkpoint patches from synthetic events — they would overwrite real ones
        }
        projected++;
      }

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Write a single synthetic checkpoint to record the backfill
    const checkpointId = `checkpoint:${chain.namespace}:${chain.chainId}`;
    const checkpoint: GovernanceCheckpointView = {
      id: checkpointId,
      chain,
      finalized: true,
      observedAt,
      source: { adapter: "backfill" },
      projection: {
        version: "1",
        hash: `backfill:${projected}`,
        projectedAt: observedAt,
        projector: "GovernanceBackfillService",
      },
    };
    await this.store.saveProjection(GOVERNANCE_CHECKPOINT, checkpointId, checkpoint);

    return { projected, checkpoint };
  }
}
