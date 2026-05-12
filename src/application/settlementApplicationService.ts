/**
 * Settlement Application Service — handles RewardIntent and SettlementBatch
 * ActionIntents.
 *
 * Uses a guardian veto window: after a RewardIntent is created, it stays in
 * "pending" for a configurable period.  The settlement process manager watches
 * for this deadline and moves approved intents into a SettlementBatch.
 */

import { z } from "zod";
import { createEvent, makeId } from "@concord/foundation";
import type { ActionIntentDispatcher, DispatchContext } from "./actionIntentDispatcher.js";
import type { ActionIntent, ActionIntentResult } from "./types.js";
import { badRequest, notFound } from "../domain/errors.js";
import { SettlementRepository } from "../contexts/settlement/repository.js";
import type { RewardIntent, SettlementBatch } from "../contexts/settlement/types.js";

const createRewardIntentSchema = z.object({
  organizationId: z.string().min(1),
  recipientId: z.string().min(1),
  reason: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1).default("DOT"),
  sourceRef: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  guardianVetoWindowMs: z.number().optional().default(86400000), // 24h
});

const vetoRewardSchema = z.object({
  rewardIntentId: z.string().min(1),
  organizationId: z.string().min(1),
  reason: z.string().optional(),
});

const createSettlementBatchSchema = z.object({
  organizationId: z.string().min(1),
  rewardIntentIds: z.array(z.string().min(1)).min(1),
});

const rewardIntentIdSchema = z.object({
  rewardIntentId: z.string().min(1),
  organizationId: z.string().min(1),
});

const confirmSettlementBatchSchema = z.object({
  settlementBatchId: z.string().min(1),
  organizationId: z.string().min(1),
  txHash: z.string().optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCreateRewardIntent(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = createRewardIntentSchema.parse(intent.payload);
  const repo = new SettlementRepository(ctx.store);

  const now = new Date().toISOString();
  const vetoDeadline = new Date(Date.now() + payload.guardianVetoWindowMs).toISOString();

  const reward: RewardIntent = {
    id: makeId("rwd"),
    organizationId: payload.organizationId,
    recipientId: payload.recipientId,
    reason: payload.reason,
    amount: payload.amount,
    currency: payload.currency,
    sourceRef: payload.sourceRef,
    status: "pending",
    guardianVetoDeadline: vetoDeadline,
    createdBy: ctx.principalId,
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveRewardIntent(reward);

  const event = createEvent({ type: "RewardIntentCreated", payload: { ...reward }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "RewardIntent", id: reward.id }, status: "accepted", events: [event] };
}

async function handleApproveRewardIntent(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = rewardIntentIdSchema.parse(intent.payload);
  const repo = new SettlementRepository(ctx.store);
  const reward = await repo.getRewardIntent(payload.rewardIntentId);
  if (!reward) throw notFound("RewardIntent", payload.rewardIntentId);
  if (reward.status !== "pending") throw badRequest(`RewardIntent is already ${reward.status}`);

  const now = new Date().toISOString();
  const next: RewardIntent = { ...reward, status: "approved", updatedAt: now };
  await repo.saveRewardIntent(next);

  const event = createEvent({ type: "RewardIntentApproved", payload: { ...next }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);
  return { eventId: event.id, aggregateRef: { kind: "RewardIntent", id: reward.id }, status: "accepted", events: [event] };
}

async function handleVetoReward(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = vetoRewardSchema.parse(intent.payload);
  const repo = new SettlementRepository(ctx.store);

  const reward = await repo.getRewardIntent(payload.rewardIntentId);
  if (!reward) throw notFound("RewardIntent", payload.rewardIntentId);
  if (reward.status !== "pending") throw badRequest(`RewardIntent is already ${reward.status}`);
  if (reward.guardianVetoDeadline && new Date() > new Date(reward.guardianVetoDeadline)) {
    throw badRequest("Guardian veto window has expired");
  }

  const now = new Date().toISOString();
  await repo.saveRewardIntent({ ...reward, status: "vetoed", updatedAt: now });

  const event = createEvent({ type: "RewardIntentVetoed", payload: { rewardIntentId: reward.id, reason: payload.reason }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "RewardIntent", id: reward.id }, status: "accepted", events: [event] };
}

async function handleCreateSettlementBatch(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = createSettlementBatchSchema.parse(intent.payload);
  const repo = new SettlementRepository(ctx.store);

  // Validate all reward intents exist and are approved
  const rewards = await Promise.all(payload.rewardIntentIds.map((id) => repo.getRewardIntent(id)));
  for (const r of rewards) {
    if (!r) throw notFound("RewardIntent", "one-or-more");
    if (r.status !== "approved") throw badRequest(`RewardIntent ${r.id} is not approved (status: ${r.status})`);
  }

  const totalAmount = rewards.reduce((acc, r) => acc + BigInt(r!.amount), 0n).toString();
  const currency = rewards[0]!.currency;

  const now = new Date().toISOString();
  const batch: SettlementBatch = {
    id: makeId("sbt"),
    organizationId: payload.organizationId,
    rewardIntentIds: payload.rewardIntentIds,
    totalAmount,
    currency,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await repo.saveBatch(batch);

  const event = createEvent({ type: "SettlementBatchCreated", payload: { ...batch }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);

  return { eventId: event.id, aggregateRef: { kind: "SettlementBatch", id: batch.id }, status: "accepted", events: [event] };
}

async function handleConfirmSettlementBatch(intent: ActionIntent, ctx: DispatchContext): Promise<ActionIntentResult> {
  const payload = confirmSettlementBatchSchema.parse(intent.payload);
  const repo = new SettlementRepository(ctx.store);
  const batch = await repo.getBatch(payload.settlementBatchId);
  if (!batch) throw notFound("SettlementBatch", payload.settlementBatchId);

  const now = new Date().toISOString();
  const next: SettlementBatch = {
    ...batch,
    status: "confirmed",
    txHash: payload.txHash ?? `mock_tx_${batch.id}`,
    confirmedAt: now,
    updatedAt: now,
  };
  await repo.saveBatch(next);

  await Promise.all(batch.rewardIntentIds.map(async (id) => {
    const reward = await repo.getRewardIntent(id);
    if (reward) await repo.saveRewardIntent({ ...reward, status: "settled", updatedAt: now });
  }));

  const event = createEvent({ type: "SettlementConfirmed", payload: { ...next }, actorId: ctx.principalId as never });
  ctx.eventBus.publish(event);
  return { eventId: event.id, aggregateRef: { kind: "SettlementBatch", id: batch.id }, status: "accepted", events: [event] };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerSettlementHandlers(dispatcher: ActionIntentDispatcher): void {
  dispatcher.register("CreateRewardIntent", handleCreateRewardIntent);
  dispatcher.register("ApproveRewardIntent", handleApproveRewardIntent);
  dispatcher.register("VetoReward", handleVetoReward);
  dispatcher.register("CreateSettlementBatch", handleCreateSettlementBatch);
  dispatcher.register("ConfirmSettlementBatch", handleConfirmSettlementBatch);
}
