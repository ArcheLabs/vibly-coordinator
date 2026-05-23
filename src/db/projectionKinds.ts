/**
 * Projection kind constants for coordinatorStore.saveProjection / getProjection.
 */

export const GOVERNANCE_SUBJECT_VIEW = "governance_subject_view" as const;
export const GOVERNANCE_VOTE_ACTIVITY = "governance_vote_activity" as const;
export const GOVERNANCE_DELEGATION = "governance_delegation" as const;
export const GOVERNANCE_CHECKPOINT = "governance_checkpoint" as const;
export const GOVERNANCE_INTENT_CHAIN_LINK = "governance_intent_chain_link" as const;
export const GOVERNANCE_TX_RECEIPT = "governance_tx_receipt" as const;

export const SCENARIO_RUN = "scenario_run" as const;
export const GUARDIAN_REQUEST = "guardian_request" as const;
export const PROJECT_TIMELINE_ENTRY = "project_timeline_entry" as const;
export const REWARD_INTENT = "reward_intent" as const;
export const REPUTATION_EVIDENCE = "reputation_evidence" as const;
export const SLASH_REQUEST = "slash_request" as const;
export const TRACE = "trace" as const;

// ─── Coordination flow v0.2 projection kinds ─────────────────────────────────
export const COORDINATION_ROUND = "coordination_round_v1" as const;
export const REVIEW_CYCLE = "review_cycle_v1" as const;
export const AGENT_OBLIGATION = "agent_obligation_v1" as const;
export const AGENT_NOTIFICATION = "agent_notification_v1" as const;
export const AGENT_NOTIFICATION_SEQUENCE = "agent_notification_sequence_v1" as const;
export const SELECTION_AUDIT = "selection_audit_v1" as const;
export const AGENT_CONNECTION_STATUS = "agent_connection_status_v1" as const;
