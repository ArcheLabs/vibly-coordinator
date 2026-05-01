import type {
  GovernanceBackendDescriptor,
  GovernanceCheckpointView,
  GovernanceIntentChainLink,
  GovernanceSubjectView,
  GovernanceVoteActivityView,
} from "@concord/governance";
import { buildMergedView, isCheckpointStale } from "./mergeBuilder.js";
import type { GovernanceBackendHealth, GovernanceBackendReadModel, GovernanceTxReceiptProjection } from "./types.js";

export function chainsEqual(
  left: { namespace?: string; chainId?: string },
  right: { namespace?: string; chainId?: string },
): boolean {
  return left.namespace === right.namespace && left.chainId === right.chainId;
}

export function selectCheckpointForChain(
  checkpoints: GovernanceCheckpointView[],
  chain: { namespace?: string; chainId?: string },
): GovernanceCheckpointView | undefined {
  return checkpoints
    .filter((checkpoint) => chainsEqual(checkpoint.chain, chain))
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
}

export function buildBackendHealth(
  descriptor: GovernanceBackendDescriptor,
  checkpoints: GovernanceCheckpointView[],
): GovernanceBackendHealth {
  const checkpoint = selectCheckpointForChain(checkpoints, descriptor.chain);
  if (!checkpoint) {
    return {
      status: "unavailable",
      stale: true,
      reason: "checkpoint_missing",
    };
  }

  const stale = isCheckpointStale(checkpoint);
  const health: GovernanceBackendHealth = {
    status: stale ? "stale" : "healthy",
    stale,
    lastObservedAt: checkpoint.observedAt,
    checkpoint,
  };
  if (stale) health.reason = "checkpoint_age_exceeds_threshold";
  return health;
}

export function buildBackendReadModels(
  descriptors: GovernanceBackendDescriptor[],
  checkpoints: GovernanceCheckpointView[],
): GovernanceBackendReadModel[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    health: buildBackendHealth(descriptor, checkpoints),
  }));
}

export function selectReceiptsForGovernanceView(
  receipts: GovernanceTxReceiptProjection[],
  intentId?: string,
  subjectId?: string,
): GovernanceTxReceiptProjection[] {
  return receipts
    .filter(
      (receipt) =>
        (intentId !== undefined && receipt.intentId === intentId) ||
        (subjectId !== undefined && receipt.subjectId === subjectId),
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function findGovernanceSubjectForReconciliation(
  subjects: GovernanceSubjectView[],
  input: { subjectId?: string; externalId?: string },
): GovernanceSubjectView | undefined {
  if (input.subjectId) {
    return subjects.find((subject) => subject.id === input.subjectId);
  }
  if (input.externalId) {
    return subjects.find(
      (subject) => subject.backend === "substrate-opengov" && subject.externalId === input.externalId,
    );
  }
  return undefined;
}

export function computeVoteReadbackStatus(
  voteReceipts: GovernanceTxReceiptProjection[],
  votes: GovernanceVoteActivityView[],
): "not_submitted" | "pending_indexer" | "indexed" {
  if (voteReceipts.length === 0) return "not_submitted";
  if (votes.length > 0) return "indexed";
  return "pending_indexer";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function summarizePayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    type: record["type"],
    pallet: record["pallet"],
    call: record["call"],
  };
}

export function selectCheckpointForGovernanceView(
  checkpoints: GovernanceCheckpointView[],
  subject?: GovernanceSubjectView,
  link?: GovernanceIntentChainLink,
): GovernanceCheckpointView | undefined {
  const chain = subject?.chain ?? link?.chain;
  if (chain) {
    const matching = checkpoints
      .filter((checkpoint) => chainsEqual(checkpoint.chain, chain))
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
    return matching[0];
  }

  return checkpoints
    .slice()
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
}

export function enrichMergedViewObservability(input: {
  base: ReturnType<typeof buildMergedView>;
  receipts: GovernanceTxReceiptProjection[];
  intentId?: string;
  subjectId?: string;
  votes?: GovernanceVoteActivityView[];
}) {
  const actionReceipts = selectReceiptsForGovernanceView(input.receipts, input.intentId, input.subjectId);
  const submitReceipt = actionReceipts.find((receipt) => receipt.action === "submitProposal");
  const voteReceipts = actionReceipts.filter((receipt) => receipt.action === "castVote");
  const indexedVotes = input.votes ?? input.base.votes ?? [];
  const linked = Boolean(input.base.subject && input.base.link);
  const pendingReadback = actionReceipts.some((receipt) => receipt.readbackStatus === "pending_indexer") && !linked;
  return {
    ...input.base,
    actionReceipts,
    submitReceipt,
    voteReceipts,
    readbackStatus: linked ? "linked" : (actionReceipts[0]?.readbackStatus ?? "not_submitted"),
    readback: {
      pending: pendingReadback,
      linked,
      linkedSubjectId: input.base.subject?.id,
      submitTxHash: submitReceipt?.tx.txHash,
      voteReceiptCount: voteReceipts.length,
      indexedVoteCount: indexedVotes.length,
      voteReadbackStatus: computeVoteReadbackStatus(voteReceipts, indexedVotes),
    },
  };
}
