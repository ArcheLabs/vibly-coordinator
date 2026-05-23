import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { COORDINATION_ROUND } from "../../db/projectionKinds.js";
import type { CoordinationRound } from "./types.js";

export class RoundRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async save(round: CoordinationRound): Promise<void> {
    await this.store.saveProjection(COORDINATION_ROUND, round.id, round);
  }

  async get(id: string): Promise<CoordinationRound | undefined> {
    return this.store.getProjection<CoordinationRound>(COORDINATION_ROUND, id);
  }

  async list(): Promise<CoordinationRound[]> {
    return this.store.listProjections<CoordinationRound>(COORDINATION_ROUND);
  }

  async findActive(): Promise<CoordinationRound | undefined> {
    const all = await this.list();
    return all.find((r) => r.status === "active");
  }

  async findByIndex(roundIndex: number): Promise<CoordinationRound | undefined> {
    const all = await this.list();
    return all.find((r) => r.roundIndex === roundIndex);
  }

  async findLatest(): Promise<CoordinationRound | undefined> {
    const all = await this.list();
    if (all.length === 0) return undefined;
    return all.reduce((latest, r) => (r.roundIndex > latest.roundIndex ? r : latest));
  }
}
