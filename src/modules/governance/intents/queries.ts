import { GovernanceProjectionRepository } from "../shared/repository.js";

export async function getIntentById(repo: GovernanceProjectionRepository, id: string) {
  return repo.getProjection("governance_intent", id);
}
