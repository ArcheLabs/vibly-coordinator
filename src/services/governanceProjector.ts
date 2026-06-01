/**
 * GovernanceProjectorService
 *
 * Maps NormalizedChainEvent<GovernanceEventType> (backed by GovernanceProposalSummary
 * payloads from the SubQuery indexer) to GovernanceProjectionPatch[].
 *
 * Design principles:
 * - Never throws on invalid/unknown events — returns [] instead.
 * - Produces a checkpoint patch for every valid event.
 * - IDs are deterministic for idempotency (SQLite upsert deduplicates).
 */

import type { NormalizedChainEvent } from "@vibly-ai/concord-core";
import type {
  GovernanceEventType,
  GovernanceProposalSummary,
  GovernanceProjectionPatch,
  GovernanceProjector,
  GovernanceSubjectView,
  GovernanceVoteActivityView,
  GovernanceDelegationView,
  GovernanceCheckpointView,
  ProjectionSource,
  ProjectionMetadata,
} from "@vibly-ai/concord-governance";

const PROJECTOR_NAME = "GovernanceProjectorService";
const SCHEMA_VERSION = "1";

function makeSource(event: NormalizedChainEvent<string>): ProjectionSource {
  return {
    adapter: "subquery",
    schemaVersion: SCHEMA_VERSION,
  };
}

function makeProjection(event: NormalizedChainEvent<string>): ProjectionMetadata {
  return {
    version: SCHEMA_VERSION,
    hash: event.id,
    projectedAt: new Date().toISOString(),
    projector: PROJECTOR_NAME,
  };
}

function makeSubjectId(event: NormalizedChainEvent<string>, externalId: string): string {
  return `${event.chain.namespace}:${event.chain.chainId}:${externalId}`;
}

function makeVoteId(subjectId: string, voter: string): string {
  return `vote:${subjectId}:${voter}`;
}

function makeDelegationId(chainId: string, delegator: string, scope?: string): string {
  return scope
    ? `delegation:${chainId}:${delegator}:${scope}`
    : `delegation:${chainId}:${delegator}`;
}

function makeCheckpointId(event: NormalizedChainEvent<string>): string {
  return `checkpoint:${event.chain.namespace}:${event.chain.chainId}`;
}

/** Build a serializable cursor — converts bigint blockNumber to string. */
function makeCursor(event: NormalizedChainEvent<string>) {
  if (event.blockNumber === undefined) return undefined;
  return {
    blockNumber: String(event.blockNumber),
    blockHash: event.blockHash,
    eventIndex: event.logIndex,
    extrinsicIndex: event.extrinsicIndex,
  };
}

function buildCheckpointPatch(
  event: NormalizedChainEvent<string>,
): GovernanceProjectionPatch {
  const id = makeCheckpointId(event);
  const view: GovernanceCheckpointView = {
    id,
    chain: event.chain,
    cursor: makeCursor(event),
    finalized: event.finality === "finalized",
    observedAt: event.observedAt,
    source: makeSource(event),
    projection: makeProjection(event),
  };
  return { kind: "checkpoint", id, value: view };
}

type ProposalPayload = GovernanceProposalSummary & {
  voter?: string;
  stance?: string;
  conviction?: string;
  balance?: string;
  delegatee?: string;
  scope?: string;
};

export class GovernanceProjectorService implements GovernanceProjector<GovernanceEventType> {
  project(
    event: NormalizedChainEvent<GovernanceEventType>,
  ): GovernanceProjectionPatch[] {
    try {
      return this.doProject(event);
    } catch {
      return [];
    }
  }

  private doProject(
    event: NormalizedChainEvent<GovernanceEventType>,
  ): GovernanceProjectionPatch[] {
    const payload = event.payload as ProposalPayload | undefined;
    const patches: GovernanceProjectionPatch[] = [];

    switch (event.type) {
      case "GovernanceProposalDiscovered":
      case "GovernanceProposalUpdated":
      case "GovernanceExecutionQueued":
      case "GovernanceExecuted":
      case "GovernanceFinalityUpdated": {
        const externalId = payload?.ref?.externalId;
        if (!externalId) return [];
        const subjectId = makeSubjectId(event, externalId);
        const view: GovernanceSubjectView = {
          id: subjectId,
          chain: event.chain,
          backend: payload?.ref?.backend ?? "substrate-opengov",
          externalId,
          title: payload?.title,
          description: payload?.description,
          proposer: payload?.proposer,
          status: payload?.status ?? "unknown",
          lifecycle: {
            discoveredAt: event.type === "GovernanceProposalDiscovered"
              ? event.observedAt
              : payload?.createdAt,
            updatedAt: payload?.updatedAt ?? event.observedAt,
          },
          chainCursor: makeCursor(event),
          finality: (event.finality as GovernanceSubjectView["finality"]) ?? "unknown",
          source: makeSource(event),
          projection: makeProjection(event),
          metadata: payload?.metadata,
        };
        patches.push({ kind: "subject", id: subjectId, value: view });
        patches.push(buildCheckpointPatch(event));
        break;
      }

      case "GovernanceVoteCast": {
        const externalId = payload?.ref?.externalId;
        const voter = payload?.voter;
        if (!externalId || !voter) return [];
        const subjectId = makeSubjectId(event, externalId);
        const voteId = makeVoteId(subjectId, voter);
        const voteView: GovernanceVoteActivityView = {
          id: voteId,
          subjectId,
          chain: event.chain,
          backend: payload?.ref?.backend ?? "substrate-opengov",
          externalId,
          voter,
          stance: payload?.stance ?? "unknown",
          conviction: payload?.conviction,
          balance: payload?.balance,
          chainCursor: makeCursor(event),
          finality: (event.finality as GovernanceVoteActivityView["finality"]) ?? "unknown",
          source: makeSource(event),
          projection: makeProjection(event),
        };
        patches.push({ kind: "vote", id: voteId, value: voteView });
        patches.push(buildCheckpointPatch(event));
        break;
      }

      case "GovernanceDelegated":
      case "GovernanceUndelegated": {
        const delegatee = payload?.delegatee;
        const delegator = payload?.ref?.externalId ?? payload?.proposer;
        if (!delegator) return [];
        const chainId = event.chain.chainId ?? "unknown";
        const scope = payload?.scope;
        const delegationId = makeDelegationId(chainId, delegator, scope);
        const delegationView: GovernanceDelegationView = {
          id: delegationId,
          chain: event.chain,
          backend: payload?.ref?.backend ?? "substrate-opengov",
          scope,
          delegator,
          delegatee: delegatee ?? "",
          conviction: payload?.conviction,
          balance: payload?.balance,
          isActive: event.type === "GovernanceDelegated",
          chainCursor: makeCursor(event),
          finality: (event.finality as GovernanceDelegationView["finality"]) ?? "unknown",
          source: makeSource(event),
          projection: makeProjection(event),
        };
        patches.push({ kind: "delegation", id: delegationId, value: delegationView });
        patches.push(buildCheckpointPatch(event));
        break;
      }

      default:
        return [];
    }

    return patches;
  }
}
