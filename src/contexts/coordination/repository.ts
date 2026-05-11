import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { ObservationTask, AssignmentOffer, Observation, DiscussionThread, Proposal, VotingRound } from "./types.js";

const K = {
  OBSERVATION: "observation_v2",
  OBSERVATION_TASK: "observation_task_v2",
  ASSIGNMENT_OFFER: "assignment_offer_v2",
  DISCUSSION: "discussion_thread_v2",
  PROPOSAL: "proposal_v2",
  VOTING_ROUND: "voting_round_v2",
} as const;

export class CoordinationRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  // ─── Observation ───────────────────────────────────────────────────────────
  async saveObservation(o: Observation): Promise<void> { await this.store.saveProjection(K.OBSERVATION, o.id, o); }
  async getObservation(id: string): Promise<Observation | undefined> { return this.store.getProjection<Observation>(K.OBSERVATION, id); }
  async listObservations(organizationId?: string): Promise<Observation[]> {
    const all = await this.store.listProjections<Observation>(K.OBSERVATION);
    return organizationId ? all.filter((o) => o.organizationId === organizationId) : all;
  }

  // ─── ObservationTask ───────────────────────────────────────────────────────
  async saveObservationTask(t: ObservationTask): Promise<void> { await this.store.saveProjection(K.OBSERVATION_TASK, t.id, t); }
  async getObservationTask(id: string): Promise<ObservationTask | undefined> { return this.store.getProjection<ObservationTask>(K.OBSERVATION_TASK, id); }
  async listObservationTasks(organizationId?: string): Promise<ObservationTask[]> {
    const all = await this.store.listProjections<ObservationTask>(K.OBSERVATION_TASK);
    return organizationId ? all.filter((t) => t.organizationId === organizationId) : all;
  }

  // ─── AssignmentOffer ───────────────────────────────────────────────────────
  async saveAssignmentOffer(a: AssignmentOffer): Promise<void> { await this.store.saveProjection(K.ASSIGNMENT_OFFER, a.id, a); }
  async getAssignmentOffer(id: string): Promise<AssignmentOffer | undefined> { return this.store.getProjection<AssignmentOffer>(K.ASSIGNMENT_OFFER, id); }
  async listAssignmentOffersForPrincipal(principalId: string): Promise<AssignmentOffer[]> {
    const all = await this.store.listProjections<AssignmentOffer>(K.ASSIGNMENT_OFFER);
    return all.filter((a) => a.assigneeId === principalId);
  }

  // ─── Discussion ────────────────────────────────────────────────────────────
  async saveDiscussion(d: DiscussionThread): Promise<void> { await this.store.saveProjection(K.DISCUSSION, d.id, d); }
  async getDiscussion(id: string): Promise<DiscussionThread | undefined> { return this.store.getProjection<DiscussionThread>(K.DISCUSSION, id); }
  async listDiscussions(organizationId?: string): Promise<DiscussionThread[]> {
    const all = await this.store.listProjections<DiscussionThread>(K.DISCUSSION);
    return organizationId ? all.filter((d) => d.organizationId === organizationId) : all;
  }

  // ─── Proposal ─────────────────────────────────────────────────────────────
  async saveProposal(p: Proposal): Promise<void> { await this.store.saveProjection(K.PROPOSAL, p.id, p); }
  async getProposal(id: string): Promise<Proposal | undefined> { return this.store.getProjection<Proposal>(K.PROPOSAL, id); }
  async listProposals(organizationId?: string): Promise<Proposal[]> {
    const all = await this.store.listProjections<Proposal>(K.PROPOSAL);
    return organizationId ? all.filter((p) => p.organizationId === organizationId) : all;
  }

  // ─── VotingRound ──────────────────────────────────────────────────────────
  async saveVotingRound(v: VotingRound): Promise<void> { await this.store.saveProjection(K.VOTING_ROUND, v.id, v); }
  async getVotingRound(id: string): Promise<VotingRound | undefined> { return this.store.getProjection<VotingRound>(K.VOTING_ROUND, id); }
  async listVotingRounds(organizationId?: string): Promise<VotingRound[]> {
    const all = await this.store.listProjections<VotingRound>(K.VOTING_ROUND);
    return organizationId ? all.filter((v) => v.organizationId === organizationId) : all;
  }
}
