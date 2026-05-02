import type { FastifyInstance } from "fastify";
import type { GovernanceVoteStance } from "@concord/governance";
import { forbidden, notFound } from "../../../domain/errors.js";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import { createSubstrateGovernanceActionsAdapter } from "../shared/substrateAdapter.js";
import { summarizePayload } from "../shared/readModel.js";
import type { GovernanceTxReceiptProjection } from "../shared/types.js";

export interface VoteOpenGovInput {
  voter: string;
  stance: GovernanceVoteStance;
  weight?: string;
  reason?: string;
  conviction?: string | number;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export async function castSubjectVoteOpenGov(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
  subjectId: string,
  input: VoteOpenGovInput,
): Promise<GovernanceTxReceiptProjection> {
  const subject = await repo.getSubject(subjectId);
  if (!subject) throw notFound("GovernanceSubjectView", subjectId);
  if (subject.backend !== "substrate-opengov") {
    throw forbidden("Only substrate-opengov subjects can use vote-opengov");
  }

  const adapter = await createSubstrateGovernanceActionsAdapter(fastify);
  const metadata = { ...(input.metadata ?? {}) };
  if (input.conviction !== undefined) metadata["conviction"] = input.conviction;
  const prepared = await adapter.prepareVote({
    subject: { chain: subject.chain, backend: subject.backend, externalId: subject.externalId },
    voter: input.voter,
    stance: input.stance,
    weight: input.weight,
    reason: input.reason,
    metadata,
  });
  const tx = await adapter.castVote({
    subject: prepared.subject,
    voter: input.voter,
    payload: input.payload ?? prepared.payload,
  });

  const now = new Date().toISOString();
  const id = `governance-tx:castVote:${tx.txHash}`;
  const receipt: GovernanceTxReceiptProjection = {
    id,
    subjectId: subject.id,
    action: "castVote",
    backend: "substrate-opengov",
    chain: subject.chain,
    actor: input.voter,
    tx,
    payloadSummary: summarizePayload(prepared.payload),
    readbackStatus: "pending_indexer",
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveTxReceipt(id, receipt);

  const { createEvent } = await import("@concord/foundation");
  const evt = createEvent({
    type: "GovernanceVoteSubmittedOpenGov",
    payload: { subjectId: subject.id, receipt },
  });
  await fastify.concord.state.events.append(evt);
  fastify.eventBus.publish(evt);

  return receipt;
}
