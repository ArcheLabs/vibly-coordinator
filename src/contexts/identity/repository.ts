import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import type { AgentProfile, ChainRootIdentity, Principal } from "./types.js";

const KIND_PRINCIPAL = "principal_v2";
const KIND_AGENT_PROFILE = "agent_profile_v2";
const KIND_CHAIN_ROOT_IDENTITY = "chain_root_identity_v1";

export class IdentityRepository {
  constructor(private readonly store: CoordinatorStorePort) {}

  async savePrincipal(p: Principal): Promise<void> {
    await this.store.saveProjection(KIND_PRINCIPAL, p.id, p);
  }

  async getPrincipal(id: string): Promise<Principal | undefined> {
    return this.store.getProjection<Principal>(KIND_PRINCIPAL, id);
  }

  async listPrincipals(): Promise<Principal[]> {
    return this.store.listProjections<Principal>(KIND_PRINCIPAL);
  }

  async saveAgentProfile(profile: AgentProfile): Promise<void> {
    await this.store.saveProjection(KIND_AGENT_PROFILE, profile.principalId, profile);
  }

  async getAgentProfile(principalId: string): Promise<AgentProfile | undefined> {
    return this.store.getProjection<AgentProfile>(KIND_AGENT_PROFILE, principalId);
  }

  async listAgentProfiles(): Promise<AgentProfile[]> {
    return this.store.listProjections<AgentProfile>(KIND_AGENT_PROFILE);
  }

  async saveChainRootIdentity(identity: ChainRootIdentity): Promise<void> {
    await this.store.saveProjection(KIND_CHAIN_ROOT_IDENTITY, identity.id, identity);
  }

  async getChainRootIdentity(chainId: string, ownerAccountHex: string): Promise<ChainRootIdentity | undefined> {
    return this.store.getProjection<ChainRootIdentity>(KIND_CHAIN_ROOT_IDENTITY, chainRootIdentityId(chainId, ownerAccountHex));
  }

  async listChainRootIdentities(): Promise<ChainRootIdentity[]> {
    return this.store.listProjections<ChainRootIdentity>(KIND_CHAIN_ROOT_IDENTITY);
  }
}

export function chainRootIdentityId(chainId: string, ownerAccountHex: string): string {
  return `${chainId}:${ownerAccountHex.toLowerCase()}`;
}
