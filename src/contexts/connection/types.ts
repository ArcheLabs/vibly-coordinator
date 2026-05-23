export type ConnectionStatus = "connected" | "disconnected" | "reconnecting" | "paused_on_chain";

export interface AgentConnectionState {
  agentId: string;
  status: ConnectionStatus;
  lastSeenAt?: string;
  disconnectedAt?: string;
  debounceUntil?: string;
  source: "notification-stream" | "client-report" | "indexer";
  updatedAt: string;
}
