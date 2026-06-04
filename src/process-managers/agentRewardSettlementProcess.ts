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
import { AgentRewardChainActions, type RewardChainReceipt } from "../services/agentRewardChainActions.js";

const COMMAND_KIND = "agent_reward_chain_command_v1";
const DAY_MS = 86_400_000;

type CommandStatus = "pending" | "submitted" | "indexed" | "failed";

interface AgentRewardChainCommand {
  id: string;
  type: "base_staking_day" | "observer_round" | "reviewer_round" | "task_reward";
  status: CommandStatus;
  dayIndex?: number;
  roundId?: string;
  taskId?: string;
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
  receipt?: RewardChainReceipt;
  submittedAt?: string;
  indexedAt?: string;
  updatedAt: string;
  payload?: Record<string, unknown>;
}

export function startAgentRewardSettlementProcess(
  eventBus: EventBus,
  store: CoordinatorStorePort,
  config: CoordinatorConfig,
): Unsubscribe {
  if (!config.agentRewardEnabled) return () => {};

  const actions = new AgentRewardChainActions(config);
  const intervalMs = config.agentRewardSettlementIntervalMs;
  const timer = intervalMs > 0
    ? setInterval(() => {
      void settlePendingBaseDays(store, actions, config, eventBus);
    }, intervalMs)
    : undefined;
  if (intervalMs > 0) void settlePendingBaseDays(store, actions, config, eventBus);

  const unsubscribe = eventBus.subscribe(async (env) => {
    try {
      if (env.type === "CoordinationRoundClosed") {
        await settleObserverRound(store, actions, config, eventBus, env.payload as Record<string, unknown>);
      } else if (env.type === "ReviewRoundCompleted") {
        await settleReviewerRound(store, actions, config, eventBus, env.payload as Record<string, unknown>);
      } else if (env.type === "TaskAccepted" || env.type === "TaskRewardApproved") {
        await settleTaskReward(store, actions, config, eventBus, env.payload as Record<string, unknown>);
      }
    } catch (err) {
      console.error("[AgentRewardSettlementProcess]", err);
    }
  });

  return () => {
    if (timer) clearInterval(timer);
    unsubscribe();
  };
}

async function settlePendingBaseDays(
  store: CoordinatorStorePort,
  actions: AgentRewardChainActions,
  config: CoordinatorConfig,
  eventBus: EventBus,
): Promise<void> {
  const currentDay = rewardDayIndexFor(config, new Date().toISOString());
  if (currentDay == null) return;

  const rewardRepo = new RewardRepository(store);
  const stakeRepo = new StakeRepository(store);
  const ledgers = (await stakeRepo.listLedgers())
    .filter((ledger) => ledger.chainId === config.substrateChainId && ledger.status === "active")
    .filter((ledger) => ledger.identityId && ledger.chainAgentId)
    .map((ledger) => ({ identityId: ledger.identityId, agentId: ledger.chainAgentId }));
  if (ledgers.length === 0) return;

  const days = await rewardRepo.listRewardDays();
  const lastSettled = days
    .filter((day) => day.chainId === config.substrateChainId && day.baseStakingSettled)
    .reduce((max, day) => Math.max(max, day.dayIndex), -1);
  const startDay = lastSettled >= 0 ? lastSettled + 1 : 0;
  const targetDay = Math.min(currentDay, startDay + config.agentRewardMaxCatchupDays - 1);

  for (let dayIndex = startDay; dayIndex <= targetDay; dayIndex += 1) {
    const commandId = `base:${config.substrateChainId}:${dayIndex}`;
    await submitCommand({
      store,
      eventBus,
      config,
      commandId,
      type: "base_staking_day",
      dayIndex,
      payload: { agents: ledgers },
      isIndexed: async () => Boolean((await rewardRepo.listRewardDays())
        .find((day) => day.chainId === config.substrateChainId && day.dayIndex === dayIndex && day.baseStakingSettled)),
      submit: () => actions.settleBaseStakingDay(dayIndex, ledgers),
      eventPayload: (receipt) => ({ settlementType: "base_staking_day", dayIndex, receipt }),
    });
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
  const dayIndex = rewardDayIndexFor(config, round.updatedAt);
  if (dayIndex == null) return;
  const commandId = `observer:${config.substrateChainId}:${roundId}`;
  const indexedId = `${config.substrateChainId}:Observer:${roundId}`;
  await submitCommand({
    store,
    eventBus,
    config,
    commandId,
    type: "observer_round",
    dayIndex,
    roundId,
    payload: { participants },
    isIndexed: async () => Boolean(await new RewardRepository(store).getRoundSettlement(indexedId)),
    submit: () => actions.settleObserverRound(roundId, dayIndex, participants),
    eventPayload: (receipt) => ({ settlementType: "observer_round", roundId, dayIndex, receipt }),
  });
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
  const dayIndex = rewardDayIndexFor(config, String(payload["updatedAt"] ?? new Date().toISOString()));
  if (dayIndex == null) return;
  const commandId = `reviewer:${config.substrateChainId}:${roundId}`;
  const indexedId = `${config.substrateChainId}:Reviewer:${roundId}`;
  await submitCommand({
    store,
    eventBus,
    config,
    commandId,
    type: "reviewer_round",
    dayIndex,
    roundId,
    payload: { participants },
    isIndexed: async () => Boolean(await new RewardRepository(store).getRoundSettlement(indexedId)),
    submit: () => actions.settleReviewerRound(roundId, dayIndex, participants),
    eventPayload: (receipt) => ({ settlementType: "reviewer_round", roundId, dayIndex, receipt }),
  });
}

async function settleTaskReward(
  store: CoordinatorStorePort,
  actions: AgentRewardChainActions,
  config: CoordinatorConfig,
  eventBus: EventBus,
  payload: Record<string, unknown>,
): Promise<void> {
  const taskId = String(payload["id"] ?? payload["taskId"] ?? "");
  if (!taskId) return;

  const rewardRepo = new RewardRepository(store);
  const approval = await rewardRepo.getTaskRewardApproval(taskId);
  if (!approval) return;

  const task = await new WorkRepository(store).getTask(taskId);
  const assigneeId = task?.assigneeId;
  if (!assigneeId || (task.status !== "accepted" && task.status !== "submitted")) return;

  const executor = (await principalIdsToAgentRefs(store, [assigneeId], config.substrateChainId))[0];
  if (!executor) return;
  const dayIndex = rewardDayIndexFor(config, task.updatedAt ?? new Date().toISOString());
  if (dayIndex == null) return;
  const commandId = `task:${config.substrateChainId}:${taskId}`;
  await submitCommand({
    store,
    eventBus,
    config,
    commandId,
    type: "task_reward",
    dayIndex,
    taskId,
    payload: { executor, difficulty: approval.difficulty },
    isIndexed: async () => Boolean(await rewardRepo.getTaskRewardSettlement(taskId)),
    submit: () => actions.settleTaskReward(taskId, dayIndex, executor, approval.difficulty),
    eventPayload: (receipt) => ({ settlementType: "task_reward", taskId, dayIndex, receipt }),
  });
}

async function submitCommand(input: {
  store: CoordinatorStorePort;
  eventBus: EventBus;
  config: CoordinatorConfig;
  commandId: string;
  type: AgentRewardChainCommand["type"];
  dayIndex?: number;
  roundId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
  isIndexed: () => Promise<boolean>;
  submit: () => Promise<RewardChainReceipt>;
  eventPayload: (receipt: RewardChainReceipt) => Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  const existing = await input.store.getProjection<AgentRewardChainCommand>(COMMAND_KIND, input.commandId);

  if (await input.isIndexed()) {
    if (existing?.status !== "indexed") {
      await saveCommand(input.store, {
        ...baseCommand(input, existing),
        status: "indexed",
        indexedAt: now,
        updatedAt: now,
      });
    }
    return;
  }

  if (existing?.status === "submitted" || existing?.status === "indexed") return;
  if (existing?.status === "failed" && existing.nextRetryAt && Date.parse(existing.nextRetryAt) > Date.now()) return;

  const pending = {
    ...baseCommand(input, existing),
    status: "pending" as const,
    updatedAt: now,
  };
  await saveCommand(input.store, pending);

  try {
    const receipt = await input.submit();
    const submittedAt = new Date().toISOString();
    await saveCommand(input.store, {
      ...pending,
      status: "submitted",
      attempts: pending.attempts + 1,
      receipt,
      submittedAt,
      lastError: undefined,
      nextRetryAt: undefined,
      updatedAt: submittedAt,
    });
    input.eventBus.publish(createEvent({
      type: "AgentRewardSettlementSubmitted",
      payload: { commandId: input.commandId, ...input.eventPayload(receipt) },
      actorId: input.config.coordinatorId as never,
    }));
  } catch (err) {
    const failedAt = new Date().toISOString();
    const attempts = pending.attempts + 1;
    await saveCommand(input.store, {
      ...pending,
      status: "failed",
      attempts,
      lastError: err instanceof Error ? err.message : String(err),
      nextRetryAt: new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
      updatedAt: failedAt,
    });
  }
}

function baseCommand(
  input: {
    commandId: string;
    type: AgentRewardChainCommand["type"];
    dayIndex?: number;
    roundId?: string;
    taskId?: string;
    payload?: Record<string, unknown>;
  },
  existing?: AgentRewardChainCommand,
): AgentRewardChainCommand {
  return {
    id: input.commandId,
    type: input.type,
    status: existing?.status ?? "pending",
    dayIndex: input.dayIndex,
    roundId: input.roundId,
    taskId: input.taskId,
    attempts: existing?.attempts ?? 0,
    lastError: existing?.lastError,
    nextRetryAt: existing?.nextRetryAt,
    receipt: existing?.receipt,
    submittedAt: existing?.submittedAt,
    indexedAt: existing?.indexedAt,
    updatedAt: existing?.updatedAt ?? new Date().toISOString(),
    payload: input.payload,
  };
}

async function saveCommand(store: CoordinatorStorePort, command: AgentRewardChainCommand): Promise<void> {
  await store.saveProjection(COMMAND_KIND, command.id, command);
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 15_000 * Math.max(1, attempts));
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

function rewardDayIndexFor(config: CoordinatorConfig, iso: string): number | undefined {
  if (!config.agentRewardEmissionStartAt) return undefined;
  const start = Date.parse(config.agentRewardEmissionStartAt);
  const value = Date.parse(iso);
  if (!Number.isFinite(start) || !Number.isFinite(value) || value < start) return undefined;
  return Math.floor((value - start) / DAY_MS);
}
