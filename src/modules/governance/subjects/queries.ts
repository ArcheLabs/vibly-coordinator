import type { FastifyInstance } from "fastify";
import type { GovernanceCheckpointView } from "@vibly-ai/concord-governance";
import { GovernanceProjectionRepository } from "../shared/repository.js";

/** Indexer `getGovernanceCheckpoint` returns Concord chain-indexing checkpoint shapes; keep loose to avoid coupling to `@vibly-ai/concord-chain-indexing`. */
export type GovernanceCheckpointQueryResult =
  | { checkpoint: GovernanceCheckpointView | null; items: GovernanceCheckpointView[] }
  | { checkpoint: GovernanceCheckpointView | null; note: string }
  | { checkpoint: unknown | null };

export async function queryGovernanceCheckpoint(
  fastify: FastifyInstance,
  repo: GovernanceProjectionRepository,
  query: { backend?: string; chainId?: string },
): Promise<GovernanceCheckpointQueryResult> {
  const { backend, chainId } = query;
  const storedCheckpoints = await repo.listCheckpoints();
  if (storedCheckpoints.length > 0 || backend || chainId) {
    const descriptors = fastify.governanceBackendRegistry.listDescriptors();
    const backendChains = backend
      ? descriptors.filter((descriptor) => descriptor.backend === backend).map((descriptor) => descriptor.chain)
      : [];
    const items = repo.filterCheckpointsForQuery(storedCheckpoints, { backend, chainId }, backendChains);
    return { checkpoint: items[0] ?? null, items };
  }

  const indexQuery = fastify.concord.governanceIndexQuery;
  if (!indexQuery) {
    return { checkpoint: null, note: "governanceIndexQuery not configured" };
  }
  const substrateChainId = fastify.config.substrateChainId ?? "substrate:vibly-solo";
  const chain = { namespace: "substrate" as const, chainId: substrateChainId };
  const checkpoint = await indexQuery.getGovernanceCheckpoint({ chain });
  return { checkpoint };
}
