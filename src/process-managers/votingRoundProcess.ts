/**
 * VotingRoundProcess — selects voters when a VotingRound is created,
 * and closes the round when all votes are in or the deadline passes.
 */

import { createEvent } from "@concord/foundation";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { MechanismRepository } from "../contexts/mechanism/repository.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { selectParticipants, evaluateVotingDecision } from "../contexts/mechanism/mechanismEngine.js";
import { applyVotingRound, applyProposal } from "../contexts/coordination/aggregate.js";

export function startVotingRoundProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const payload = env.payload as Record<string, unknown>;
      const votingRoundId = payload["id"] as string | undefined;
      if (!votingRoundId) return;

      try {
        const coordRepo = new CoordinationRepository(store);
        const mechanismRepo = new MechanismRepository(store);
        const identityRepo = new IdentityRepository(store);

        const votingRound = await coordRepo.getVotingRound(votingRoundId);
        if (!votingRound || votingRound.status !== "open") return;

        const mechanism = votingRound.mechanismId ? await mechanismRepo.get(votingRound.mechanismId) : undefined;
        const rule = mechanism?.voterSelection;

        const agents = await identityRepo.listAgentProfiles();
        const candidates = agents.map((a) => a.principalId);

        const { selected } = selectParticipants(rule ?? { primitive: "random-selection", count: 5 }, { candidates });

        const voteRequestEvent = createEvent({
          type: "VoteRequested",
          payload: { votingRoundId, voterIds: selected },
          causationId: env.id,
        });
        eventBus.publish(voteRequestEvent);
      } catch (err) {
        console.error("[VotingRoundProcess]", err);
      }
    },
    (env) => env.type === "VotingRoundCreated",
  );
}

/**
 * Listen for VoteSubmitted events and close the round if it reaches a decision.
 */
export function startVoteCountProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
): Unsubscribe {
  return eventBus.subscribe(
    async (env) => {
      const payload = env.payload as Record<string, unknown>;
      const votingRoundId = payload["votingRoundId"] as string | undefined;
      if (!votingRoundId) return;

      try {
        const coordRepo = new CoordinationRepository(store);
        const mechanismRepo = new MechanismRepository(store);

        const votingRound = await coordRepo.getVotingRound(votingRoundId);
        if (!votingRound || votingRound.status !== "open") return;

        // Check if deadline has passed
        if (votingRound.deadline && new Date() < new Date(votingRound.deadline)) return;

        const approveCount = votingRound.votes.filter((v) => v.stance === "approve").length;
        const rejectCount = votingRound.votes.filter((v) => v.stance === "reject").length;
        const abstainCount = votingRound.votes.filter((v) => v.stance === "abstain").length;

        const mechanism = votingRound.mechanismId ? await mechanismRepo.get(votingRound.mechanismId) : undefined;
        const decision = evaluateVotingDecision({
          approveCount,
          rejectCount,
          abstainCount,
          totalEligible: votingRound.votes.length,
          rule: mechanism?.votingRule,
        });

        if (decision === "pending") return;

        const now = new Date().toISOString();
        const result = { outcome: decision, approveCount, rejectCount, abstainCount };

        const updated = applyVotingRound(votingRound, { type: "VotingRoundClosed", payload: { votingRoundId, result, closedAt: now } });
        await coordRepo.saveVotingRound(updated);

        // Update proposal status
        if (votingRound.proposalId) {
          const proposal = await coordRepo.getProposal(votingRound.proposalId);
          if (proposal) {
            const proposalEvent = decision === "approved"
              ? { type: "ProposalAccepted" as const, payload: { proposalId: proposal.id, acceptedAt: now } }
              : { type: "ProposalRejected" as const, payload: { proposalId: proposal.id, rejectedAt: now } };
            const nextProposal = applyProposal(proposal, proposalEvent);
            await coordRepo.saveProposal(nextProposal);
            const propEnv = createEvent({ type: proposalEvent.type, payload: proposalEvent.payload, causationId: env.id });
            eventBus.publish(propEnv);
          }
        }

        const closedEnv = createEvent({ type: "VotingRoundClosed", payload: { votingRoundId, result, closedAt: now }, causationId: env.id });
        eventBus.publish(closedEnv);
      } catch (err) {
        console.error("[VoteCountProcess]", err);
      }
    },
    (env) => env.type === "VoteSubmitted",
  );
}
