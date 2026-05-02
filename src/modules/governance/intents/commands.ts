import type { FastifyInstance } from "fastify";
import type { ChainRef, TxReceipt } from "@concord/core";
import type { GovernanceIntentChainLink } from "@concord/governance";
import { notFound } from "../../../domain/errors.js";
import { GovernanceProjectionRepository } from "../shared/repository.js";
import { createSubstrateGovernanceActionsAdapter } from "../shared/substrateAdapter.js";
import { findGovernanceSubjectForReconciliation, summarizePayload } from "../shared/readModel.js";
import type { GovernanceTxReceiptProjection } from "../shared/types.js";

export interface CreateIntentInput {
  projectId?: string;
  kind: string;
  actionId?: string;
  decisionRecordId?: string;
  title: string;
  body?: string;
}

export interface SubmitOpenGovInput {
  actor: string;
  payload?: unknown;
  submitArgs?: unknown;
  externalId?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}

export interface LinkSubjectInput {
  subjectId: string;
  externalId?: string;
  backend?: string;
  linkSource?: string;
  confidence?: string;
  metadata?: Record<string, unknown>;
}

export interface ReconcileSubjectInput {
  subjectId?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export async function createIntent(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
  input: CreateIntentInput,
) {
  const { createEvent, makeId } = await import("@concord/foundation");
  const now = new Date().toISOString();
  const intent = {
    id: makeId("GovernanceIntentId"),
    projectId: input.projectId,
    kind: input.kind,
    actionId: input.actionId,
    decisionRecordId: input.decisionRecordId,
    title: input.title,
    body: input.body,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveRawProjection("governance_intent", String(intent.id), intent);
  const evt = createEvent({ type: "GovernanceIntentCreated", payload: intent });
  await fastify.concord.state.events.append(evt);
  fastify.eventBus.publish(evt);
  return intent;
}

async function saveGovernanceTxReceipt(
  repo: GovernanceProjectionRepository,
  input: {
    intentId?: string;
    subjectId?: string;
    action: GovernanceTxReceiptProjection["action"];
    chain: ChainRef;
    actor: string;
    tx: TxReceipt;
    payloadSummary?: Record<string, unknown>;
    readbackStatus: GovernanceTxReceiptProjection["readbackStatus"];
  },
): Promise<GovernanceTxReceiptProjection> {
  const now = new Date().toISOString();
  const id = `governance-tx:${input.action}:${input.tx.txHash}`;
  const receipt: GovernanceTxReceiptProjection = {
    id,
    action: input.action,
    backend: "substrate-opengov",
    chain: input.chain,
    actor: input.actor,
    tx: input.tx,
    readbackStatus: input.readbackStatus,
    createdAt: now,
    updatedAt: now,
  };
  if (input.intentId !== undefined) receipt.intentId = input.intentId;
  if (input.subjectId !== undefined) receipt.subjectId = input.subjectId;
  if (input.payloadSummary !== undefined) receipt.payloadSummary = input.payloadSummary;
  await repo.saveTxReceipt(id, receipt);
  return receipt;
}

async function maybeLinkSubmittedIntent(
  repo: GovernanceProjectionRepository,
  input: {
    intentId: string;
    chain: ChainRef;
    externalId?: string;
    subjectId?: string;
    tx: TxReceipt;
  },
): Promise<GovernanceIntentChainLink | null> {
  const externalId = input.externalId ?? input.subjectId;
  if (!externalId) return null;
  const now = new Date().toISOString();
  const subjectId = input.subjectId ?? `${input.chain.namespace}:${input.chain.chainId}:${externalId}`;
  const link: GovernanceIntentChainLink = {
    id: `link:${input.intentId}:${subjectId}`,
    governanceIntentId: input.intentId,
    subjectId,
    chain: input.chain,
    backend: "substrate-opengov",
    externalId,
    linkSource: input.subjectId ? "explicit" : "tx_receipt",
    confidence: input.subjectId ? "high" : "medium",
    createdAt: now,
    updatedAt: now,
    metadata: { txHash: input.tx.txHash, readbackStatus: "pending_indexer" },
  };
  await repo.saveIntentChainLink(link.id, link);
  return link;
}

export async function submitIntentOpenGov(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
  governanceIntentId: string,
  input: SubmitOpenGovInput,
) {
  const intent = await repo.getProjection<{
    id: string;
    projectId?: string;
    kind: string;
    title: string;
    body?: string;
    status: string;
  }>("governance_intent", governanceIntentId);
  if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

  const chain = {
    namespace: "substrate" as const,
    chainId: fastify.config.substrateChainId ?? "substrate:vibly-solo",
  };
  const adapter = await createSubstrateGovernanceActionsAdapter(fastify);
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    governanceIntentId: intent.id,
  };
  if (input.submitArgs !== undefined) metadata["submitArgs"] = input.submitArgs;
  const prepareInput = {
    chain,
    actor: input.actor,
    title: intent.title,
    metadata,
  };
  if (intent.body !== undefined) {
    (prepareInput as typeof prepareInput & { description: string }).description = intent.body;
  }
  const prepared = await adapter.prepareProposal(prepareInput);
  const tx = await adapter.submitProposal({
    chain,
    actor: input.actor,
    payload: input.payload ?? prepared.payload,
  });
  const receipt = await saveGovernanceTxReceipt(repo, {
    intentId: intent.id,
    action: "submitProposal",
    chain,
    actor: input.actor,
    tx,
    payloadSummary: summarizePayload(prepared.payload),
    readbackStatus: input.subjectId || input.externalId ? "linked" : "pending_indexer",
  });

  const updated = {
    ...intent,
    status: "submitted",
    submitReceiptId: receipt.id,
    readbackStatus: receipt.readbackStatus,
    updatedAt: receipt.updatedAt,
  };
  await repo.saveIntent(intent.id, updated);

  const link = await maybeLinkSubmittedIntent(repo, {
    intentId: intent.id,
    chain,
    externalId: input.externalId,
    subjectId: input.subjectId,
    tx,
  });

  const { createEvent } = await import("@concord/foundation");
  const evt = createEvent({
    type: "GovernanceSubmittedOpenGov",
    payload: { governanceIntentId: intent.id, receipt, link },
  });
  await fastify.concord.state.events.append(evt);
  fastify.eventBus.publish(evt);

  return { governanceIntent: updated, receipt, link };
}

export async function submitIntentMock(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
  governanceIntentId: string,
) {
  const intent = await repo.getProjection<{
    id: string;
    kind: string;
    title: string;
    body?: string;
    status: string;
  }>("governance_intent", governanceIntentId);
  if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

  const result = await fastify.concord.governanceGateway.submitProposal({
    kind: intent.kind,
    title: intent.title,
    body: intent.body ?? "",
    referenceId: intent.id,
  });

  const updated = { ...intent, status: "submitted", mockResult: result, updatedAt: new Date().toISOString() };
  await repo.saveIntent(intent.id, updated);

  const { createEvent } = await import("@concord/foundation");
  const evt = createEvent({
    type: "GovernanceSubmittedMock",
    payload: { governanceIntentId: intent.id, result },
  });
  await fastify.concord.state.events.append(evt);
  fastify.eventBus.publish(evt);

  return { governanceIntent: updated, result };
}

export async function linkIntentToSubject(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
  governanceIntentId: string,
  input: LinkSubjectInput,
): Promise<GovernanceIntentChainLink> {
  const intent = await repo.getProjection("governance_intent", governanceIntentId);
  if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

  const now = new Date().toISOString();
  const linkId = `link:${governanceIntentId}:${input.subjectId}`;
  const subject = await repo.getSubject(input.subjectId);

  const chainId = fastify.config.substrateChainId ?? "substrate:vibly-solo";
  const link: GovernanceIntentChainLink = {
    id: linkId,
    governanceIntentId,
    subjectId: input.subjectId,
    chain: subject?.chain ?? { namespace: "substrate", chainId },
    backend:
      (input.backend as GovernanceIntentChainLink["backend"]) ??
      subject?.backend ??
      "substrate-opengov",
    externalId: input.externalId ?? subject?.externalId ?? input.subjectId,
    linkSource: (input.linkSource as GovernanceIntentChainLink["linkSource"]) ?? "explicit",
    confidence: (input.confidence as GovernanceIntentChainLink["confidence"]) ?? "high",
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
  };
  await repo.saveIntentChainLink(linkId, link);
  return link;
}

export async function reconcileIntentWithSubject(
  repo: GovernanceProjectionRepository,
  governanceIntentId: string,
  input: ReconcileSubjectInput,
) {
  const intent = await repo.getProjection<{
    id: string;
    status: string;
    submitReceiptId?: string;
    readbackStatus?: string;
  }>("governance_intent", governanceIntentId);
  if (!intent) throw notFound("GovernanceIntent", governanceIntentId);

  const allSubjects = await repo.listAllSubjects();
  const subject = findGovernanceSubjectForReconciliation(allSubjects, input);
  if (!subject) {
    throw notFound("GovernanceSubjectView", input.subjectId ?? input.externalId ?? "missing");
  }

  const now = new Date().toISOString();
  const link: GovernanceIntentChainLink = {
    id: `link:${intent.id}:${subject.id}`,
    governanceIntentId: intent.id,
    subjectId: subject.id,
    chain: subject.chain,
    backend: subject.backend,
    externalId: subject.externalId,
    linkSource: "metadata_match",
    confidence: "high",
    createdAt: now,
    updatedAt: now,
    metadata: {
      ...(input.metadata ?? {}),
      reconciledAt: now,
      readbackStatus: "linked",
    },
  };
  await repo.saveIntentChainLink(link.id, link);

  const allReceipts = await repo.listAllTxReceipts();
  const receipts = allReceipts.filter((receipt) => receipt.intentId === intent.id);
  for (const receipt of receipts) {
    await repo.saveTxReceipt(receipt.id, {
      ...receipt,
      subjectId: subject.id,
      readbackStatus: "linked",
      updatedAt: now,
    } satisfies GovernanceTxReceiptProjection);
  }

  const updated = {
    ...intent,
    status: subject.status,
    readbackStatus: "linked",
    updatedAt: now,
  };
  await repo.saveIntent(intent.id, updated);

  return { governanceIntent: updated, link, receiptsTouched: receipts.length };
}
