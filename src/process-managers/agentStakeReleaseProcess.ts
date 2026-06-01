import { createEvent } from "@vibly-ai/concord-foundation";
import { listBlockingObligations } from "../application/organizationApplicationService.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { StakeRepository } from "../contexts/stake/repository.js";
import type { AgentStakeLedger } from "../contexts/stake/types.js";
import type { CoordinatorConfig } from "../config/env.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus } from "../services/eventBus.js";
import { AgentStakeChainActions } from "../services/agentStakeChainActions.js";

const COMMAND_KIND = "agent_stake_chain_command_v1";
const COMPLETION_EVENTS = new Set([
  "AssignmentAccepted",
  "AssignmentTimedOut",
  "ObservationSubmitted",
  "DiscussionOutcomeRecorded",
  "ReviewRoundCompleted",
  "TaskAccepted",
  "TaskRejected",
  "ArtifactAccepted",
  "ArtifactRejected",
]);

export function startAgentStakeReleaseProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
  config: CoordinatorConfig,
): void {
  const actions = new AgentStakeChainActions(config);
  eventBus.subscribe(async (event) => {
    try {
      if (event.type === "AgentStakeReleaseBlockRequested") {
        await submitBlockIfNeeded(store, eventBus, actions, config, event.payload as Record<string, unknown>);
      } else if (event.type === "AgentStakeReleaseClearRequested") {
        await submitClearIfNeeded(store, eventBus, actions, config, event.payload as Record<string, unknown>);
      } else if (COMPLETION_EVENTS.has(event.type)) {
        await requestClearsForUnblockedObligations(store, eventBus, config);
      }
    } catch (err) {
      console.error("[AgentStakeReleaseProcess]", err);
    }
  });
}

async function submitBlockIfNeeded(
  store: CoordinatorStorePort,
  eventBus: EventBus,
  actions: AgentStakeChainActions,
  config: CoordinatorConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const ledger = payload as unknown as AgentStakeLedger;
  const commandId = `${ledger.id}:block`;
  if (await store.getProjection(COMMAND_KIND, commandId)) return;
  const reasonRef = typeof ledger.releaseBlockReason === "string" ? ledger.releaseBlockReason : `obligations:${ledger.principalId ?? ledger.chainAgentId}`;
  const receipt = await actions.blockRelease(ledger, reasonRef);
  await store.saveProjection(COMMAND_KIND, commandId, {
    id: commandId,
    ledgerId: ledger.id,
    action: "block_release",
    receipt,
    submittedAt: new Date().toISOString(),
  });
  eventBus.publish(createEvent({
    type: "AgentStakeReleaseBlockSubmitted",
    payload: { ledger, receipt },
    actorId: config.coordinatorId as never,
  }));
}

async function submitClearIfNeeded(
  store: CoordinatorStorePort,
  eventBus: EventBus,
  actions: AgentStakeChainActions,
  config: CoordinatorConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const ledger = payload as unknown as AgentStakeLedger;
  const commandId = `${ledger.id}:clear`;
  if (await store.getProjection(COMMAND_KIND, commandId)) return;
  const receipt = await actions.clearReleaseBlock(ledger);
  await store.saveProjection(COMMAND_KIND, commandId, {
    id: commandId,
    ledgerId: ledger.id,
    action: "clear_release_block",
    receipt,
    submittedAt: new Date().toISOString(),
  });
  eventBus.publish(createEvent({
    type: "AgentStakeReleaseClearSubmitted",
    payload: { ledger, receipt },
    actorId: config.coordinatorId as never,
  }));
}

async function requestClearsForUnblockedObligations(
  store: CoordinatorStorePort,
  eventBus: EventBus,
  config: CoordinatorConfig,
): Promise<void> {
  const stakeRepo = new StakeRepository(store);
  const identityRepo = new IdentityRepository(store);
  for (const ledger of await stakeRepo.listLedgers()) {
    if (ledger.status !== "unbonding" || !ledger.releaseBlocked) continue;
    const profile = ledger.principalId
      ? await identityRepo.getAgentProfile(ledger.principalId)
      : (await identityRepo.listAgentProfiles()).find((candidate) =>
        candidate.chainId === ledger.chainId &&
        candidate.identityId === ledger.identityId &&
        candidate.chainAgentId === ledger.chainAgentId,
      );
    if (!profile) continue;
    const blockers = await listBlockingObligations(store, profile.principalId);
    if (blockers.length > 0) continue;
    eventBus.publish(createEvent({
      type: "AgentStakeReleaseClearRequested",
      payload: { ...ledger, principalId: profile.principalId },
      actorId: config.coordinatorId as never,
    }));
  }
}
