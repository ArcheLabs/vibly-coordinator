export type NotificationType =
  | "observation_assigned"
  | "review_assigned"
  | "review_cycle_started"
  | "task_accepted"
  | "task_rejected"
  | "task_unresolved_timeout"
  | "observation_paused"
  | "observation_resumed"
  | "organization_joined"
  | "organization_removed"
  | "organization_role_changed"
  | "organization_paused"
  | "organization_resumed"
  | "stake_action_required";

export type NotificationStatus = "created" | "delivered" | "acknowledged" | "expired";

export interface AgentNotification {
  id: string;
  sequence: number;
  agentId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  ackDeadlineAt?: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentNotificationSequence {
  agentId: string;
  nextSequence: number;
  updatedAt: string;
}
