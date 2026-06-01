import { paginateList } from "../../../domain/pagination.js";
import type { CoordinatorStorePort } from "../../../db/coordinatorStorePort.js";
import {
  GOVERNANCE_SUBJECT_VIEW,
  GOVERNANCE_VOTE_ACTIVITY,
  GOVERNANCE_DELEGATION,
  GOVERNANCE_CHECKPOINT,
  GOVERNANCE_INTENT_CHAIN_LINK,
  GOVERNANCE_TX_RECEIPT,
} from "../../../db/projectionKinds.js";
import type {
  GovernanceSubjectView,
  GovernanceVoteActivityView,
  GovernanceDelegationView,
  GovernanceCheckpointView,
  GovernanceIntentChainLink,
} from "@vibly-ai/concord-governance";
import type { GovernanceTxReceiptProjection } from "./types.js";
import { chainsEqual } from "./readModel.js";

export interface ListGovernanceSubjectsParams {
  chainId?: string;
  status?: string;
  backend?: string;
  limit: number;
}

export interface ListDelegationsParams {
  chainId?: string;
  limit: number;
}

export class GovernanceProjectionRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  listLegacyGovernanceViews(): Promise<unknown[]> {
    return this.store.listProjections("governance_view");
  }

  getLegacyGovernanceView(subjectId: string): Promise<unknown | undefined> {
    return this.store.getProjection("governance_view", subjectId);
  }

  listCheckpoints(): Promise<GovernanceCheckpointView[]> {
    return this.store.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
  }

  filterCheckpointsForQuery(
    storedCheckpoints: GovernanceCheckpointView[],
    opts: { backend?: string; chainId?: string },
    backendChains: Array<{ namespace?: string; chainId?: string }>,
  ): GovernanceCheckpointView[] {
    return storedCheckpoints
      .filter((checkpoint) => !opts.chainId || checkpoint.chain.chainId === opts.chainId)
      .filter((checkpoint) => {
        if (!opts.backend) return true;
        return backendChains.some((chain) => chainsEqual(chain, checkpoint.chain));
      })
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
  }

  listAllSubjects(): Promise<GovernanceSubjectView[]> {
    return this.store.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
  }

  async listSubjects(params: ListGovernanceSubjectsParams): Promise<GovernanceSubjectView[]> {
    let items = await this.listAllSubjects();
    if (params.chainId) items = items.filter((s) => s.chain?.chainId === params.chainId);
    if (params.status) items = items.filter((s) => s.status === params.status);
    if (params.backend) items = items.filter((s) => s.backend === params.backend);
    return paginateList(items, params.limit, 0);
  }

  getSubject(subjectId: string): Promise<GovernanceSubjectView | undefined> {
    return this.store.getProjection<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW, subjectId);
  }

  async listVotesForSubject(subjectId: string): Promise<GovernanceVoteActivityView[]> {
    const all = await this.store.listProjections<GovernanceVoteActivityView>(GOVERNANCE_VOTE_ACTIVITY);
    return all.filter((v) => v.subjectId === subjectId);
  }

  async listDelegations(params: ListDelegationsParams): Promise<GovernanceDelegationView[]> {
    let items = await this.store.listProjections<GovernanceDelegationView>(GOVERNANCE_DELEGATION);
    if (params.chainId) items = items.filter((d) => d.chain?.chainId === params.chainId);
    return paginateList(items, params.limit, 0);
  }

  async loadMergedProjectionBundle(projectId?: string): Promise<{
    intents: Array<{
      id: string;
      projectId?: string;
      title?: string;
      status?: string;
      proposedBy?: string;
      createdAt?: string;
    }>;
    subjects: GovernanceSubjectView[];
    links: GovernanceIntentChainLink[];
    checkpoints: GovernanceCheckpointView[];
    receipts: GovernanceTxReceiptProjection[];
  }> {
    const intentRows = await this.store.listProjections<{
      id: string;
      projectId?: string;
      title?: string;
      status?: string;
      proposedBy?: string;
      createdAt?: string;
    }>("governance_intent");
    const intents = intentRows.filter((i) => !projectId || i.projectId === projectId);
    const subjects = await this.store.listProjections<GovernanceSubjectView>(GOVERNANCE_SUBJECT_VIEW);
    const links = await this.store.listProjections<GovernanceIntentChainLink>(GOVERNANCE_INTENT_CHAIN_LINK);
    const checkpoints = await this.store.listProjections<GovernanceCheckpointView>(GOVERNANCE_CHECKPOINT);
    const receipts = await this.store.listProjections<GovernanceTxReceiptProjection>(GOVERNANCE_TX_RECEIPT);
    return { intents, subjects, links, checkpoints, receipts };
  }

  getProjection<T>(kind: string, id: string): Promise<T | undefined> {
    return this.store.getProjection<T>(kind, id);
  }

  getIntent<T>(id: string): Promise<T | undefined> {
    return this.store.getProjection<T>("governance_intent", id);
  }

  saveIntent<T>(id: string, value: T): Promise<void> {
    return this.store.saveProjection("governance_intent", id, value);
  }

  listIntentChainLinks(): Promise<GovernanceIntentChainLink[]> {
    return this.store.listProjections<GovernanceIntentChainLink>(GOVERNANCE_INTENT_CHAIN_LINK);
  }

  saveIntentChainLink(id: string, link: GovernanceIntentChainLink): Promise<void> {
    return this.store.saveProjection(GOVERNANCE_INTENT_CHAIN_LINK, id, link);
  }

  listAllVoteActivity(): Promise<GovernanceVoteActivityView[]> {
    return this.store.listProjections<GovernanceVoteActivityView>(GOVERNANCE_VOTE_ACTIVITY);
  }

  listAllTxReceipts(): Promise<GovernanceTxReceiptProjection[]> {
    return this.store.listProjections<GovernanceTxReceiptProjection>(GOVERNANCE_TX_RECEIPT);
  }

  saveTxReceipt(id: string, receipt: GovernanceTxReceiptProjection): Promise<void> {
    return this.store.saveProjection(GOVERNANCE_TX_RECEIPT, id, receipt);
  }

  saveSubject(id: string, subject: GovernanceSubjectView): Promise<void> {
    return this.store.saveProjection(GOVERNANCE_SUBJECT_VIEW, id, subject);
  }

  saveCheckpoint(id: string, checkpoint: GovernanceCheckpointView): Promise<void> {
    return this.store.saveProjection(GOVERNANCE_CHECKPOINT, id, checkpoint);
  }

  saveRawProjection(kind: string, id: string, value: unknown): Promise<void> {
    return this.store.saveProjection(kind, id, value);
  }
}
