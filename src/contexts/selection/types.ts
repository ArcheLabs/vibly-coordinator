export interface SelectionAudit {
  id: string;
  roundId?: string;
  reviewCycleId?: string;
  organizationId?: string;
  scope: "review" | "observation";
  candidateIds: string[];
  excludedIds: string[];
  selectedIds: string[];
  excludeReasons: Record<string, string>;
  rule: Record<string, unknown>;
  createdAt: string;
}
