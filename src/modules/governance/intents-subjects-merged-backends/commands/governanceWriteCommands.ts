import type { FastifyInstance } from "fastify";
import type { ChainRef, TxReceipt } from "@concord/core";
import type { GovernanceIntentChainLink, GovernanceSubjectView, GovernanceCheckpointView } from "@concord/governance";
import { GovernanceProjectionRepository } from "../repositories/governanceProjectionRepository.js";
import type { GovernanceTxReceiptProjection } from "../types.js";

export async function saveGovernanceTxReceipt(
  fastify: FastifyInstance,
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
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);
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

export async function maybeLinkSubmittedIntent(
  fastify: FastifyInstance,
  input: {
    intentId: string;
    chain: ChainRef;
    externalId?: string;
    subjectId?: string;
    tx: TxReceipt;
  },
): Promise<GovernanceIntentChainLink | null> {
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);
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

export async function seedPhaseD5GovernanceDemo(fastify: FastifyInstance) {
  const repo = new GovernanceProjectionRepository(fastify.coordinatorStore);
  const now = new Date().toISOString();
  const substrateChain = {
    namespace: "substrate" as const,
    chainId: fastify.config.substrateChainId ?? "substrate:vibly-solo",
  };
  const evmChain = {
    namespace: "eip155" as const,
    chainId: fastify.config.evmChainId ?? "31337",
  };

  const projection = {
    version: "phase-d5-demo",
    hash: "phase-d5-demo-seed",
    projectedAt: now,
    projector: "vibly-coordinator:dev-seed",
  };
  const source = { adapter: "phase-d5-demo-seed" };

  const subjects: GovernanceSubjectView[] = [
    {
      id: `${substrateChain.namespace}:${substrateChain.chainId}:demo-open-gov-1`,
      chain: substrateChain,
      backend: "substrate-opengov",
      externalId: "demo-open-gov-1",
      title: "Phase D.5 Substrate OpenGov demo",
      status: "Deciding",
      lifecycle: { discoveredAt: now, updatedAt: now },
      finality: "included",
      source,
      projection,
      metadata: { seed: "phase-d5", track: "root" },
    },
    {
      id: `${evmChain.namespace}:${evmChain.chainId}:demo-evm-governor-1`,
      chain: evmChain,
      backend: "evm-governor",
      externalId: "demo-evm-governor-1",
      title: "Phase D.5 EVM Governor fixture demo",
      status: "Deciding",
      lifecycle: { discoveredAt: now, updatedAt: now },
      finality: "included",
      source,
      projection,
      metadata: { seed: "phase-d5", fixture: true },
    },
  ];

  const checkpoints: GovernanceCheckpointView[] = [
    {
      id: `checkpoint:${substrateChain.namespace}:${substrateChain.chainId}`,
      chain: substrateChain,
      cursor: { position: "phase-d5-demo-substrate", blockNumber: "1" },
      finalized: false,
      observedAt: now,
      source,
      projection,
    },
    {
      id: `checkpoint:${evmChain.namespace}:${evmChain.chainId}`,
      chain: evmChain,
      cursor: { position: "phase-d5-demo-evm", blockNumber: "1" },
      finalized: false,
      observedAt: now,
      source,
      projection,
    },
  ];

  for (const subject of subjects) {
    await repo.saveSubject(subject.id, subject);
  }
  for (const checkpoint of checkpoints) {
    await repo.saveCheckpoint(checkpoint.id, checkpoint);
  }

  return { subjects, checkpoints };
}
