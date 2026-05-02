import type { FastifyInstance } from "fastify";
import type { GovernanceCheckpointView, GovernanceSubjectView } from "@concord/governance";
import { GovernanceProjectionRepository } from "../shared/repository.js";

export async function seedPhaseD5GovernanceDemo(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
): Promise<{ subjects: GovernanceSubjectView[]; checkpoints: GovernanceCheckpointView[] }> {
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
