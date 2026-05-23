export type CoordinationRoundStatus = "active" | "closed";

export interface CoordinationRound {
  id: string;
  roundIndex: number;
  startedAt: string;
  observationSubmitDeadlineAt: string;
  endsAt: string;
  status: CoordinationRoundStatus;
  createdObservationTaskIds: string[];
  createdAt: string;
  updatedAt: string;
}
