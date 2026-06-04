import { createEvent } from "@vibly-ai/concord-foundation";
import type { CoordinatorConfig } from "../config/env.js";
import { CoordinationRepository } from "../contexts/coordination/repository.js";
import { IdentityRepository } from "../contexts/identity/repository.js";
import { RewardRepository } from "../contexts/reward/repository.js";
import type { RewardDifficulty } from "../contexts/reward/types.js";
import { RoundRepository } from "../contexts/round/repository.js";
import { StakeRepository } from "../contexts/stake/repository.js";
import { WorkRepository } from "../contexts/work/repository.js";
import type { CoordinatorStorePort } from "../db/coordinatorStorePort.js";
import type { EventBus, Unsubscribe } from "../services/eventBus.js";
import { AgentRewardChainActions } from "../services/agentRewardChainActions.js";

const COMMAND_KIND = "agent_reward_chain_command_v1";

export function startAgentRewardSettlementProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
  config: CoordinatorConfig,
): Unsubscribe {
  const actions = new AgentRewardChainActions(config);
  const timer = setInterval(() => {
    void settlePendingBaseDays(store, actions, config, eventBus);
  }, Math.max(config.agentStakeSyncIntervalMs, 60_000));
  void settlePendingBaseDays(store, actions, config, eventBus);

  const unsubscribe = eventBus.subscribe(async (env) => {
    try {
      if (env.type === "CoordinationRoundClosed") {
        await settleObserverRound(store, actions, config, eventBus, env.payload as Record<string, unknown>);
      } else if (env.type === "ReviewRoundCompleted") {
        await settleReviewerRound(store, actions, config, eventBus, env.payload as Record<string, unknown>);
      } else if (env.type === "TaskAccepted") {
        await settleTaskReward(store, actions, config, eventBus, env.payload as Record<string, unknown>);
      }
    } catch (err) {
      console.error("[AgentRewardSettlementProcess]", err);
    }
  });

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

async function settlePendingBaseDays(
  store: CoordinatorStorePort,
  actions: AgentRewardChainActions,
  config: CoordinatorConfig,
  eventBus: EventBus,
): Promise<void> {
  const rewardRepo = new RewardRepository(store);
  const stakeRepo = new StakeRepository(store);
  const ledgers = (await stakeRepo.listLedgers())
    .filter((ledger) => ledger.chainId === config.substrateChainId && ledger.status === "active")
    .filter((ledger) => ledger.identityId && ledger.chainAgentId)
    .map((ledger) => ({ identityId: ledger.identityId, agentId: ledger.chainAgentId }));
  if (ledgers.length === 0) return;

  const days = await rewardRepo.listRewardDays();
  const currentDay = utcDayIndex(new Date().toISOString());
  const lastSettled = days
    .filter((day) => day.chainId === config.substrateChainId && day.baseStakingSettled)
    .reduce((max, day) => Math.max(max, day.dayIndex), -1);
  const startDay = lastSettled >= 0 ? lastSettled + 1 : currentDay;
  for (let dayIndex = startDay; dayIndex <= currentDay; dayIndex += 1) {
    const commandId = `base:${config.substrateChainId}:${dayIndex}`;
    if (await store.getProjection(COMMAND_KIND, commandId)) continue;
    const receipt = await actions.settleBaseStakingDay(dayIndex, ledgers);
    await store.saveProjection(COMMAND_KIND, commandId, {
      id: commandId,
      type: "base_staking_day",
      dayIndex,
      receipt,
      submittedAt: new Date().toISOString(),
    });
    eventBus.publish(createEvent({
      type: "AgentRewardSettlementSubmitted",
      payload: { commandId, settlementType: "base_staking_day", dayIndex, receipt },
      actorId: config.coordinatorId as never,
    }));
  }
}

async function settleObserverRound(
  store: CoordinatorStorePort,
  actions: AgentRewardChainActions,
  config: CoordinatorConfig,
  eventBus: EventBus,
  payload: Record<string, unknown>,
): Promise<void> {
  const roundId = String(payload["id"] ?? payload["roundId"] ?? "");
  if (!roundId) return;
  const round = await new RoundRepository(store).get(roundId);
  if (!round) return;
  const participants = await observerParticipantsForRound(store, round.createdObservationTaskIds, config.substrateChainId);
  if (participants.length === 0) return;
  const dayIndex = utcDayIndex(round.updatedAt);
  const commandId = `observer:${roundId}`;
  if (await store.getProjection(COMMAND_KIND, commandId)) return;
  const receipt = await actions.settleObserverRound(roundId, dayIndex, participants);
  await store.saveProjection(COMMAND_KIND, commandId, {
    id: commandId,
    type: "observer_round",
    roundId,
    dayIndex,
    participants,
    receipt,
    submittedAt: new Date().toISOString(),
  });
  eventBus.publish(createEvent({
    type: "AgentRewardSettlementSubmitted",
    payload: { commandId, settlementType: "observer_round", roundId, dayIndex, receipt },
    actorId: config.coordinatorId as never,
  }));
}

async function settleReviewerRound(
  store: CoordinatorStorePort,
  actions: AgentRewardChainActions,
  config: CoordinatorConfig,
  eventBus: EventBus,
  payload: Record<string, unknown>,
): Promise<void> {
  const roundId = String(payload["reviewRoundId"] ?? payload["id"] ?? "");
  const reviewerIds = reviewerIdsFromPayload(payload);
  if (!roundId || reviewerIds.length === 0) return;
  const participants = await principalIdsToAgentRefs(store, reviewerIds, config.substrateChainId);
  if (participants.length === 0) return;
  const dayIndex = utcDayIndex(String(payload["updatedAt"] ?? new Date().toISOString()));
  const commandId = `reviewer:${roundId}`;
  if (await store.getProjection(COMMAND_KIND, commandId)) return;
  const receipt = await actions.settleReviewerRound(roundId, dayIndex, participants);
  await store.saveProjection(COMMAND_KIND, commandId, {
    id: commandId,
    type: "reviewer_round",
    roundId,
    dayIndex,
    participants,
    receipt,
    submittedAt: new Date().toISOString(),
  });
  eventBus.publish(createEvent({
    type: "AgentRewardSettlementSubmitted",
    payload: { commandId, settlementType: "reviewer_round", roundId, dayIndex, receipt },
    actorId: config.coordinatorId as never,
  }));
}

async function settleTaskReward(
  store: CoordinatorStorePort,
  actions: AgentRewardChainActions,
  config: CoordinatorConfig,
  eventBus: EventBus,
  payload: Record<string, unknown>,
): Promise<void> {
  const taskId = String(payload["id"] ?? payload["taskId"] ?? "");
  const assigneeId = typeof payload["assigneeId"] === "string" ? String(payload["assigneeId"]) : undefined;
  if (!taskId || !assigneeId) return;

  const rewardRepo = new RewardRepository(store);
  const approval = await rewardRepo.getTaskRewardApproval(taskId);
  if (!approval) return;
  const executor = (await principalIdsToAgentRefs(store, [assigneeId], config.substrateChainId))[0];
  if (!executor) return;
  const task = await new WorkRepository(store).getTask(taskId);
  const dayIndex = utcDayIndex(task?.updatedAt ?? new Date().toISOString());
  const commandId = `task:${taskId}`;
  if (await store.getProjection(COMMAND_KIND, commandId)) return;
  const receipt = await actions.settleTaskReward(taskId, dayIndex, executor, approval.difficulty);
  await store.saveProjection(COMMAND_KIND, commandId, {
    id: commandId,
    type: "task_reward",
    taskId,
    dayIndex,
    executor,
    difficulty: approval.difficulty,
    receipt,
    submittedAt: new Date().toISOString(),
  });
  eventBus.publish(createEvent({
    type: "AgentRewardSettlementSubmitted",
    payload: { commandId, settlementType: "task_reward", taskId, dayIndex, receipt },
    actorId: config.coordinatorId as never,
  }));
}

async function observerParticipantsForRound(
  store: CoordinatorStorePort,
  observationTaskIds: string[],
  chainId: string,
): Promise<Array<{ identityId: string; agentId: string }>> {
  const repo = new CoordinationRepository(store);
  const observations = await repo.listObservations();
  const observers = [...new Set(
    observations
      .filter((item) => item.observationTaskId && observationTaskIds.includes(item.observationTaskId))
      .map((item) => item.submittedBy),
  )];
  return principalIdsToAgentRefs(store, observers, chainId);
}

async function principalIdsToAgentRefs(
  store: CoordinatorStorePort,
  principalIds: string[],
  chainId: string,
): Promise<Array<{ identityId: string; agentId: string }>> {
  const identityRepo = new IdentityRepository(store);
  const refs: Array<{ identityId: string; agentId: string }> = [];
  for (const principalId of principalIds) {
    const profile = await identityRepo.getAgentProfile(principalId);
    if (!profile?.identityId || !profile.chainAgentId) continue;
    if (profile.chainId && profile.chainId !== chainId) continue;
    refs.push({ identityId: profile.identityId, agentId: profile.chainAgentId });
  }
  return uniqueAgentRefs(refs);
}

function reviewerIdsFromPayload(payload: Record<string, unknown>): string[] {
  const direct = Array.isArray(payload["reviewerIds"]) ? payload["reviewerIds"].filter((value): value is string => typeof value === "string") : [];
  if (direct.length > 0) return [...new Set(direct)];
  const reviews = Array.isArray(payload["reviews"]) ? payload["reviews"] : [];
  return [...new Set(reviews
    .map((review) => review && typeof review === "object" ? (review as Record<string, unknown>)["reviewerId"] : undefined)
    .filter((value): value is string => typeof value === "string"))];
}

function uniqueAgentRefs(items: Array<{ identityId: string; agentId: string }>): Array<{ identityId: string; agentId: string }> {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.identityId}:${item.agentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function utcDayIndex(iso: string): number {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return Math.floor(Date.now() / 86_400_000);
  return Math.floor(value / 86_400_000);
}
