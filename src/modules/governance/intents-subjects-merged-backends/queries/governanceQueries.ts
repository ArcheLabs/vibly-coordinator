import type { FastifyInstance } from "fastify";
import type { GovernanceCheckpointView } from "@concord/governance";
import { buildMergedView } from "../mergeBuilder.js";
import { enrichMergedViewObservability, selectCheckpointForGovernanceView } from "../readModel.js";
import { GovernanceProjectionRepository } from "../repositories/governanceProjectionRepository.js";

/** Indexer `getGovernanceCheckpoint` returns Concord chain-indexing checkpoint shapes; keep loose here to avoid coupling to `@concord/chain-indexing`. */
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

export async function queryGovernanceMergedList(
  repo: GovernanceProjectionRepository,
  opts: { projectId?: string; backend?: string; limit: number },
): Promise<ReturnType<typeof enrichMergedViewObservability>[]> {
  const { intents, subjects, links, checkpoints, receipts } = await repo.loadMergedProjectionBundle(opts.projectId);
  const { limit, backend } = opts;

  const merged: ReturnType<typeof enrichMergedViewObservability>[] = [];
  for (const intent of intents.slice(0, limit)) {
    const link = links.find((l) => l.governanceIntentId === intent.id);
    const subject = link ? subjects.find((s) => s.id === link.subjectId) : undefined;
    const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject, link);
    merged.push(
      enrichMergedViewObservability({
        base: buildMergedView({
          id: `merged:${intent.id}`,
          projectId: intent.projectId,
          intent: {
            id: intent.id,
            title: intent.title,
            status: intent.status,
            proposedBy: intent.proposedBy,
            createdAt: intent.createdAt,
          },
          subject,
          link,
          checkpoint,
        }),
        receipts,
        intentId: intent.id,
        subjectId: subject?.id,
      }),
    );
  }

  const linkedSubjectIds = new Set(links.map((l) => l.subjectId));
  for (const subject of subjects) {
    if (!linkedSubjectIds.has(subject.id) && merged.length < limit) {
      const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject);
      merged.push(
        enrichMergedViewObservability({
          base: buildMergedView({
            id: `merged:${subject.id}`,
            subject,
            checkpoint,
          }),
          receipts,
          subjectId: subject.id,
        }),
      );
    }
  }

  return backend ? merged.filter((m) => m.subject?.backend === backend) : merged;
}

export async function queryGovernanceMergedDetail(
  repo: GovernanceProjectionRepository,
  rawId: string,
): Promise<ReturnType<typeof enrichMergedViewObservability> | null> {
  const intentId = rawId.startsWith("merged:") ? rawId.slice(7) : rawId;

  const intent = await repo.getIntent<{
    id: string;
    projectId?: string;
    title?: string;
    status?: string;
    proposedBy?: string;
    createdAt?: string;
  }>(intentId);

  const allLinksMerged = await repo.listIntentChainLinks();
  const link = allLinksMerged.find((l) => l.governanceIntentId === intentId);

  const subject = link
    ? await repo.getSubject(link.subjectId)
    : await repo.getSubject(intentId);

  if (!intent && !subject) return null;

  const allVotesMerged = await repo.listAllVoteActivity();
  const votes = subject ? allVotesMerged.filter((v) => v.subjectId === subject.id) : [];
  const allRcMerged = await repo.listAllTxReceipts();
  const actionReceipts = allRcMerged.filter(
    (receipt) => receipt.intentId === intent?.id || receipt.subjectId === subject?.id,
  );
  const checkpoints = await repo.listCheckpoints();
  const checkpoint = selectCheckpointForGovernanceView(checkpoints, subject ?? undefined, link);

  return enrichMergedViewObservability({
    base: buildMergedView({
      id: rawId,
      projectId: intent?.projectId,
      intent: intent ? { id: intent.id, title: intent.title, status: intent.status } : undefined,
      subject: subject ?? undefined,
      votes,
      link,
      checkpoint,
    }),
    receipts: actionReceipts,
    intentId: intent?.id,
    subjectId: subject?.id,
    votes,
  });
}
