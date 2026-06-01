import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import { ReviewRepository } from "../contexts/evaluation/repository.js";
import { WorkRepository } from "../contexts/work/repository.js";
import { ArtifactRepository } from "../contexts/artifact/repository.js";
import { SettlementRepository } from "../contexts/settlement/repository.js";
import { selectParticipants } from "../contexts/mechanism/mechanismEngine.js";
import { applyProposal } from "../contexts/coordination/aggregate.js";
import { applyTask } from "../contexts/work/aggregate.js";
import type { DiscussionThread } from "../contexts/coordination/types.js";
import type { Artifact } from "../contexts/artifact/types.js";
import type { ReviewRound } from "../contexts/evaluation/types.js";
import type { SettlementBatch } from "../contexts/settlement/types.js";
import { filterEligibleAgents } from "../application/agentEligibility.js";

const NOTIFICATION_KIND = "agent_notification_v2";
const KNOWLEDGE_KIND = "knowledge_entry_v2";

export function startObservationDiscussionProcess(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const payload = env.payload as { observation?: Record<string, unknown>; observationTaskId?: string };
    const observation = payload.observation;
    if (!observation) return;

    try {
      const coordRepo = new CoordinationRepository(store);
      const identityRepo = new IdentityRepository(store);
      const mechanismRepo = new MechanismRepository(store);
      const organizationId = String(observation.organizationId);
      const projectId = observation.projectId ? String(observation.projectId) : undefined;
      const mechanisms = await mechanismRepo.list(organizationId);
      const rule = mechanisms[0]?.participantSelection ?? { primitive: "random-selection" as const, count: 3 };
      const agents = await filterEligibleAgents(store, await identityRepo.listAgentProfiles(), rule);
      const candidates = agents.map((agent) => agent.principalId).filter((id) => id !== observation.submittedBy);
      const { selected } = selectParticipants(rule, { candidates });
      const participantIds = selected.length > 0 ? selected : candidates.slice(0, 3);
      const now = new Date().toISOString();
      const discussion: DiscussionThread = {
        id: makeId("disc"),
        organizationId,
        projectId,
        title: `Discuss observation: ${String(observation.title ?? observation.id)}`,
        targetRef: { kind: "Observation", id: String(observation.id) },
        status: "open",
        comments: [],
        rounds: [{ index: 0, participantIds, contributions: [], createdAt: now }],
        startedBy: String(observation.submittedBy ?? "system"),
        createdAt: now,
        updatedAt: now,
      };
      await coordRepo.saveDiscussion(discussion);
      eventBus.publish(createEvent({ type: "DiscussionStarted", payload: { ...discussion }, causationId: env.id }));
      eventBus.publish(createEvent({ type: "DiscussionRoundCreated", payload: { discussionId: discussion.id, round: discussion.rounds[0] }, causationId: env.id }));
      eventBus.publish(createEvent({ type: "DiscussionParticipantSelected", payload: { discussionId: discussion.id, participantIds, organizationId, projectId }, causationId: env.id }));
    } catch (err) {
      console.error("[ObservationDiscussionProcess]", err);
    }
  }, (env) => env.type === "ObservationSubmitted");
}

export function startDiscussionOutcomeNotificationProcess(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const payload = env.payload as { discussionId?: string; outcome?: Record<string, unknown> };
    if (!payload.discussionId || !payload.outcome) return;

    try {
      const coordRepo = new CoordinationRepository(store);
      const identityRepo = new IdentityRepository(store);
      const discussion = await coordRepo.getDiscussion(payload.discussionId);
      if (!discussion) return;

      const agents = await filterEligibleAgents(store, await identityRepo.listAgentProfiles());
      const proposer = agents.find((agent) => agent.displayName.toLowerCase().includes("proposer"))
        ?? agents.find((agent) => agent.capabilities.includes("proposal_writing"))
        ?? agents[0];
      if (!proposer) return;

      const now = new Date().toISOString();
      const notification = {
        id: makeId("notify"),
        type: "ProposalCreationRequest",
        principalId: proposer.principalId,
        organizationId: discussion.organizationId,
        projectId: discussion.projectId,
        status: "open",
        payload: {
          discussionId: discussion.id,
          targetRef: discussion.targetRef,
          summary: payload.outcome.summary,
        },
        createdAt: now,
        updatedAt: now,
      };
      await store.saveProjection(NOTIFICATION_KIND, notification.id, notification);
      eventBus.publish(createEvent({ type: "ProposalCreationRequested", payload: notification, causationId: env.id }));
    } catch (err) {
      console.error("[DiscussionOutcomeNotificationProcess]", err);
    }
  }, (env) => env.type === "DiscussionOutcomeRecorded");
}

export function startProposalReviewProcess(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const proposal = env.payload as Record<string, unknown>;
    const proposalId = proposal.id as string | undefined;
    const organizationId = proposal.organizationId as string | undefined;
    if (!proposalId || !organizationId) return;

    try {
      const coordRepo = new CoordinationRepository(store);
      const reviewRepo = new ReviewRepository(store);
      const identityRepo = new IdentityRepository(store);
      const mechanismRepo = new MechanismRepository(store);
      const mechanisms = await mechanismRepo.list(organizationId);
      const rule = mechanisms[0]?.reviewerSelection ?? { primitive: "random-selection" as const, count: 2 };
      const agents = await filterEligibleAgents(store, await identityRepo.listAgentProfiles(), rule);
      const candidates = agents
        .filter((agent) => agent.principalId !== proposal.submittedBy)
        .map((agent) => agent.principalId);
      const { selected } = selectParticipants(rule, { candidates });
      const reviewerIds = selected.length > 0 ? selected : candidates.slice(0, 2);
      const now = new Date().toISOString();
      const round: ReviewRound = {
        id: makeId("rev"),
        proposalId,
        organizationId,
        targetRef: { type: "Proposal", id: proposalId },
        reviewerIds,
        reviews: [],
        status: "pending",
        mechanismId: mechanisms[0]?.id,
        createdAt: now,
        updatedAt: now,
      };
      await reviewRepo.save(round);

      const current = await coordRepo.getProposal(proposalId);
      if (current) await coordRepo.saveProposal({ ...current, status: "under-review", updatedAt: now });

      eventBus.publish(createEvent({ type: "ReviewRequested", payload: { ...round }, causationId: env.id }));
      eventBus.publish(createEvent({ type: "ReviewerSelected", payload: { reviewRoundId: round.id, reviewerIds, organizationId, proposalId }, causationId: env.id }));
      eventBus.publish(createEvent({ type: "ReviewRoundCreated", payload: { ...round }, causationId: env.id }));
    } catch (err) {
      console.error("[ProposalReviewProcess]", err);
    }
  }, (env) => env.type === "ProposalSubmitted");
}

export function startReviewOutcomeProcess(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const round = env.payload as ReviewRound & { reviewRoundId?: string };
    const outcome = round.outcome;
    if (!outcome) return;

    try {
      const coordRepo = new CoordinationRepository(store);
      const workRepo = new WorkRepository(store);
      const artifactRepo = new ArtifactRepository(store);
      const now = new Date().toISOString();

      if (round.proposalId) {
        const proposal = await coordRepo.getProposal(round.proposalId);
        if (!proposal) return;
        const proposalEvent = outcome === "accepted"
          ? { type: "ProposalAccepted" as const, payload: { proposalId: proposal.id, acceptedAt: now } }
          : { type: "ProposalRejected" as const, payload: { proposalId: proposal.id, rejectedAt: now } };
        await coordRepo.saveProposal(applyProposal(proposal, proposalEvent));
        eventBus.publish(createEvent({ type: proposalEvent.type, payload: proposalEvent.payload, causationId: env.id }));
        return;
      }

      if (round.taskId) {
        const task = await workRepo.getTask(round.taskId);
        if (!task) return;
        const taskEvent = outcome === "accepted"
          ? { type: "TaskAccepted" as const, payload: { taskId: task.id, acceptedAt: now } }
          : { type: "TaskRejected" as const, payload: { taskId: task.id, rejectedAt: now } };
        const nextTask = applyTask(task, taskEvent);
        await workRepo.saveTask(nextTask);

        const submissions = await workRepo.listSubmissions(task.id);
        const submission = round.submissionId ? submissions.find((item) => item.id === round.submissionId) : submissions.at(-1);
        for (const artifactId of submission?.artifactIds ?? []) {
          const artifact = await artifactRepo.get(artifactId);
          if (!artifact) continue;
          const nextArtifact = { ...artifact, status: outcome === "accepted" ? "accepted" as const : "rejected" as const, updatedAt: now };
          await artifactRepo.save(nextArtifact);
          eventBus.publish(createEvent({
            type: outcome === "accepted" ? "ArtifactAccepted" : "ArtifactRejected",
            payload: { artifact: nextArtifact, organizationId: task.organizationId, projectId: task.projectId },
            causationId: env.id,
          }));
        }

        eventBus.publish(createEvent({ type: taskEvent.type, payload: { ...nextTask }, causationId: env.id }));
      }
    } catch (err) {
      console.error("[ReviewOutcomeProcess]", err);
    }
  }, (env) => env.type === "ReviewRoundCompleted");
}

export function startArtifactKnowledgeProcess(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const payload = env.payload as { artifact?: Record<string, unknown>; organizationId?: string; projectId?: string };
    const artifact = payload.artifact;
    if (!artifact) return;

    try {
      const artifactRepo = new ArtifactRepository(store);
      const now = new Date().toISOString();
      const entry = {
        id: makeId("kentry"),
        organizationId: String(artifact.organizationId ?? payload.organizationId),
        projectId: artifact.projectId ? String(artifact.projectId) : payload.projectId,
        title: String(artifact.title ?? "Accepted artifact"),
        content: String(artifact.description ?? artifact.contentRef ?? ""),
        tags: Array.isArray(artifact.tags) ? artifact.tags : [],
        sourceRef: { type: "Artifact", id: String(artifact.id) },
        version: 1,
        createdBy: String(artifact.createdBy ?? "system"),
        createdAt: now,
        updatedAt: now,
      };
      await store.saveProjection(KNOWLEDGE_KIND, entry.id, entry);
      await artifactRepo.save({ ...(artifact as unknown as Artifact), status: "merged", updatedAt: now });
      eventBus.publish(createEvent({ type: "KnowledgeEntryCreated", payload: entry, causationId: env.id }));
      eventBus.publish(createEvent({ type: "ArtifactMergedToKnowledgeBase", payload: { artifactId: artifact.id, knowledgeEntryId: entry.id, organizationId: entry.organizationId, projectId: entry.projectId }, causationId: env.id }));
      eventBus.publish(createEvent({ type: "KnowledgeEntryUpdated", payload: entry, causationId: env.id }));
    } catch (err) {
      console.error("[ArtifactKnowledgeProcess]", err);
    }
  }, (env) => env.type === "ArtifactAccepted");
}

export function startRewardSettlementProcess(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe {
  return eventBus.subscribe(async (env) => {
    const reward = env.payload as Record<string, unknown>;
    const rewardIntentId = reward.id as string | undefined;
    const organizationId = reward.organizationId as string | undefined;
    if (!rewardIntentId || !organizationId) return;

    try {
      const repo = new SettlementRepository(store);
      const current = await repo.getRewardIntent(rewardIntentId);
      if (!current || current.status !== "pending") return;

      const now = new Date().toISOString();
      const approved = { ...current, status: "approved" as const, updatedAt: now };
      await repo.saveRewardIntent(approved);
      eventBus.publish(createEvent({ type: "RewardIntentApproved", payload: { ...approved }, causationId: env.id }));

      const batch: SettlementBatch = {
        id: makeId("sbt"),
        organizationId,
        rewardIntentIds: [rewardIntentId],
        totalAmount: current.amount,
        currency: current.currency,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      await repo.saveBatch(batch);
      const batchEvent = createEvent({ type: "SettlementBatchCreated", payload: { ...batch }, causationId: env.id });
      eventBus.publish(batchEvent);

      const submitted = { ...batch, status: "submitted" as const, submittedAt: now, updatedAt: now };
      await repo.saveBatch(submitted);
      eventBus.publish(createEvent({ type: "SettlementSubmitted", payload: { ...submitted }, causationId: batchEvent.id }));

      const confirmedAt = new Date().toISOString();
      const confirmed = { ...submitted, status: "confirmed" as const, txHash: `mock_tx_${batch.id}`, confirmedAt, updatedAt: confirmedAt };
      await repo.saveBatch(confirmed);
      await repo.saveRewardIntent({ ...approved, status: "settled", updatedAt: confirmedAt });
      eventBus.publish(createEvent({ type: "SettlementConfirmed", payload: { ...confirmed }, causationId: batchEvent.id }));
    } catch (err) {
      console.error("[RewardSettlementProcess]", err);
    }
  }, (env) => env.type === "RewardIntentCreated");
}

export function startE2eCollaborationProcesses(eventBus: EventBus, store: CoordinatorStorePort): Unsubscribe[] {
  return [
    startObservationDiscussionProcess(eventBus, store),
    startDiscussionOutcomeNotificationProcess(eventBus, store),
    startProposalReviewProcess(eventBus, store),
    startReviewOutcomeProcess(eventBus, store),
    startArtifactKnowledgeProcess(eventBus, store),
    startRewardSettlementProcess(eventBus, store),
  ];
}
