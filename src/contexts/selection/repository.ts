import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { SELECTION_AUDIT } from "../../db/projectionKinds.js";
import type { SelectionAudit } from "./types.js";

export interface SelectionAuditFilter {
  reviewCycleId?: string;
  roundId?: string;
  scope?: "review" | "observation";
}

export class SelectionAuditRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(audit: SelectionAudit): Promise<void> {
    await this.store.saveProjection(SELECTION_AUDIT, audit.id, audit);
  }

  async get(id: string): Promise<SelectionAudit | undefined> {
    return this.store.getProjection<SelectionAudit>(SELECTION_AUDIT, id);
  }

  async list(filter?: SelectionAuditFilter): Promise<SelectionAudit[]> {
    const all = await this.store.listProjections<SelectionAudit>(SELECTION_AUDIT);
    if (!filter) return all;
    return all.filter((a) => {
      if (filter.reviewCycleId && a.reviewCycleId !== filter.reviewCycleId) return false;
      if (filter.roundId && a.roundId !== filter.roundId) return false;
      if (filter.scope && a.scope !== filter.scope) return false;
      return true;
    });
  }
}
