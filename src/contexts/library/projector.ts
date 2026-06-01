/**
 * Public Library Projector — listens to domain events and builds
 * public read-model projections (public_library_artifact_v1, etc.).
 *
 * Status mapping:
 *   artifact_v2.status === "merged"   → "published"
 *   merged + reviewCount > 0          → "verified"
 *   new version of existing slug      → "updated" (version bump)
 *
 * hotScore formula (deterministic, no external analytics):
 *   reviewCount * 20 + recencyScore + verifiedBonus
 *   recencyScore: 20 points for < 1 day, linearly decays to 0 at 7 days.
 *   verifiedBonus: 10 points when status === "verified".
 */

import { makeId } from "@vibly-ai/concord-foundation";
import type { EventBus, Unsubscribe } from "../../services/eventBus.js";
import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { ArtifactRepository } from "../artifact/repository.js";
import { OrganizationRepository } from "../organization/repository.js";
import { IdentityRepository } from "../identity/repository.js";
import { ReviewRepository } from "../evaluation/repository.js";
import { PublicLibraryRepository } from "./repository.js";
import { generateSlug, withSuffix } from "../../utils/slug.js";
import type { PublicArtifact, PublicArtifactStatus, PublicArtifactType } from "./types.js";

const KNOWLEDGE_KIND = "knowledge_entry_v2";

// ─── Hot score computation ─────────────────────────────────────────────────

function computeHotScore(params: {
  reviewCount: number;
  status: PublicArtifactStatus;
  publishedAt: string;
}): number {
  const reviewScore = params.reviewCount * 20;
  const verifiedBonus = params.status === "verified" ? 10 : 0;

  const ageMs = Date.now() - new Date(params.publishedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 20 * (1 - ageDays / 7));

  return Math.round(reviewScore + recencyScore + verifiedBonus);
}

// ─── Slug uniqueness ─────────────────────────────────────────────────────────

async function resolveUniqueSlug(
  repo: PublicLibraryRepository,
  title: string,
  id: string,
): Promise<string> {
  const base = generateSlug(title, id);
  const existing = await repo.getArtifactBySlug(base);
  // If no conflict, or the conflict is the same id (update), use base slug
  if (!existing || existing.id === id) return base;
  return withSuffix(base, id);
}

// ─── Artifact projection builder ─────────────────────────────────────────────

async function upsertArtifactProjection(
  store: CoordinatorStorePort,
  artifactId: string,
): Promise<void> {
  const libRepo = new PublicLibraryRepository(store);
  const artifactRepo = new ArtifactRepository(store);
  const orgRepo = new OrganizationRepository(store);
  const identityRepo = new IdentityRepository(store);
  const reviewRepo = new ReviewRepository(store);

  const artifact = await artifactRepo.get(artifactId);
  if (!artifact) return;
  // Only publish merged artifacts
  if (artifact.status !== "merged") return;

  // Knowledge entry (preferred markdown source)
  const allEntries = await store.listProjections<Record<string, unknown>>(KNOWLEDGE_KIND);
  const knowledgeEntry = allEntries.find(
    (e) => (e.sourceRef as Record<string, unknown> | undefined)?.id === artifactId,
  );

  // Org info
  const org = await orgRepo.get(artifact.organizationId);
  const orgName = org?.name ?? artifact.organizationId;
  const orgSlug = generateSlug(orgName, artifact.organizationId);

  // Save/update org public projection
  const existingOrg = await store.getProjection<Record<string, unknown>>("public_library_org_v1", artifact.organizationId);
  if (!existingOrg) {
    await libRepo.saveOrganization({
      id: artifact.organizationId,
      slug: orgSlug,
      name: orgName,
      description: org?.description ?? "",
      documentCount: 0,
      agentCount: 0,
      projectCount: 0,
    });
  }

  // Author agent info
  const authorProfile = await identityRepo.getAgentProfile(artifact.createdBy);
  const authorAgentName = authorProfile?.displayName;

  // Review count
  const reviews = await reviewRepo.list(artifact.organizationId);
  const relevantReviews = reviews.filter(
    (r) => r.taskId === artifact.taskId,
  );
  const reviewCount = relevantReviews.length;
  const sourceReviewRoundIds = relevantReviews.map((r) => r.id);

  // Status
  let status: PublicArtifactStatus = "published";
  if (reviewCount > 0) status = "verified";

  // Check if existing projection has a different version (update)
  const existing = await libRepo.getArtifactById(artifactId);
  const version = existing ? existing.version + 1 : 1;
  if (existing && version > 1) status = "updated";

  const now = new Date().toISOString();
  const publishedAt = existing?.publishedAt ?? now;

  // Slug (preserve existing slug to avoid breaking URLs)
  const slug = existing?.slug ?? (await resolveUniqueSlug(libRepo, artifact.title, artifactId));

  // Infer type from tags or mimeType
  const typeFromTag = (artifact.tags ?? []).find((t: string) =>
    ["report", "spec", "note", "template"].includes(t),
  ) as PublicArtifactType | undefined;
  const type: PublicArtifactType = typeFromTag ?? "note";

  const summary = String(
    (knowledgeEntry?.content as string | undefined)?.slice(0, 200) ??
      artifact.description?.slice(0, 200) ??
      "",
  );
  const markdown = String(
    (knowledgeEntry?.content as string | undefined) ?? artifact.description ?? "",
  );

  const hotScore = computeHotScore({ reviewCount, status, publishedAt });

  const projection: PublicArtifact = {
    id: artifactId,
    title: artifact.title,
    slug,
    summary,
    markdown,
    locale: undefined,

    orgId: artifact.organizationId,
    orgSlug,
    orgName,

    projectId: (knowledgeEntry?.projectId as string | undefined) ?? (artifact as unknown as Record<string, unknown>).projectId as string | undefined,
    projectSlug: undefined,
    projectName: undefined,

    type,
    status,
    order: 0,
    tags: artifact.tags ?? [],

    authorAgentId: artifact.createdBy,
    authorAgentName,
    contributors: [],

    reviewCount,
    hotScore,
    version,

    sourceTaskId: artifact.taskId,
    sourceDiscussionId: undefined,
    sourceReviewRoundIds,
    sourceKnowledgeEntryId: knowledgeEntry ? String(knowledgeEntry.id) : undefined,

    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    publishedAt,
  };

  await libRepo.saveArtifact(projection);
  await refreshOrgDocumentCount(libRepo, store, artifact.organizationId);
  if (authorProfile) {
    await refreshAgentProjection(libRepo, identityRepo, store, artifact.createdBy);
  }
}

async function refreshOrgDocumentCount(
  libRepo: PublicLibraryRepository,
  store: CoordinatorStorePort,
  orgId: string,
): Promise<void> {
  const all = await store.listProjections<PublicArtifact>("public_library_artifact_v1");
  const count = all.filter((a) => a.orgId === orgId).length;
  const existing = await store.getProjection<Record<string, unknown>>("public_library_org_v1", orgId);
  if (existing) {
    await store.saveProjection("public_library_org_v1", orgId, { ...existing, documentCount: count });
  }
}

async function refreshAgentProjection(
  libRepo: PublicLibraryRepository,
  identityRepo: IdentityRepository,
  store: CoordinatorStorePort,
  principalId: string,
): Promise<void> {
  const profile = await identityRepo.getAgentProfile(principalId);
  if (!profile) return;

  const all = await store.listProjections<PublicArtifact>("public_library_artifact_v1");
  const docCount = all.filter(
    (a) =>
      a.authorAgentId === principalId ||
      a.contributors.some((c) => c.id === principalId),
  ).length;

  const orgId = profile.organizationIds[0];
  let orgName: string | undefined;
  let orgSlug: string | undefined;
  if (orgId) {
    const orgPub = await store.getProjection<Record<string, unknown>>("public_library_org_v1", orgId);
    orgName = orgPub ? String(orgPub.name) : undefined;
    orgSlug = orgPub ? String(orgPub.slug) : undefined;
  }

  await libRepo.saveAgent({
    id: principalId,
    name: profile.displayName,
    description: undefined,
    reputation: profile.reputationScore ?? 0,
    documentCount: docCount,
    orgName,
    orgSlug,
  });
}

// ─── Exported starter ────────────────────────────────────────────────────────

export function startPublicLibraryProjector(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      try {
        const payload = env.payload as Record<string, unknown>;

        if (env.type === "ArtifactMergedToKnowledgeBase" || env.type === "ArtifactAccepted") {
          const artifactId = String(payload.artifactId ?? payload.id ?? "");
          if (!artifactId) return;
          await upsertArtifactProjection(store, artifactId);
          return;
        }

        if (env.type === "KnowledgeEntryCreated" || env.type === "KnowledgeEntryUpdated") {
          const sourceRef = payload.sourceRef as Record<string, unknown> | undefined;
          if (sourceRef?.type === "Artifact") {
            await upsertArtifactProjection(store, String(sourceRef.id));
          }
          return;
        }

        if (env.type === "AgentProfileUpdated") {
          const principalId = String(payload.principalId ?? "");
          if (!principalId) return;
          const libRepo = new PublicLibraryRepository(store);
          const identityRepo = new IdentityRepository(store);
          await refreshAgentProjection(libRepo, identityRepo, store, principalId);
        }
      } catch (err) {
        console.error("[PublicLibraryProjector]", err);
      }
    },
    (env) =>
      env.type === "ArtifactMergedToKnowledgeBase" ||
      env.type === "ArtifactAccepted" ||
      env.type === "KnowledgeEntryCreated" ||
      env.type === "KnowledgeEntryUpdated" ||
      env.type === "AgentProfileUpdated",
  );
}
