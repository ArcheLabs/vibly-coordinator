import { createEvent, makeId } from "@vibly-ai/concord-foundation";
import type { FastifyPluginAsync } from "fastify";
import { ok } from "../../domain/apiTypes.js";
import { badRequest, forbidden, notFound } from "../../domain/errors.js";
import { envelopeKey, envelopeKeyArray } from "../../domain/schemas.js";
import { CoordinationRepository } from "../../contexts/coordination/repository.js";
import { ReviewRepository } from "../../contexts/evaluation/repository.js";
import { IdentityRepository } from "../../contexts/identity/repository.js";
import { RewardRepository } from "../../contexts/reward/repository.js";
import type { RewardDifficulty, TaskRewardApproval, TaskRewardSuggestion } from "../../contexts/reward/types.js";
import { WorkRepository } from "../../contexts/work/repository.js";
import type { CoordinatorStorePort } from "../../db/coordinatorStorePort.js";
import { WALLET_SESSION, ensureActiveWalletSession, type WalletSessionRecord } from "../../modules/identity/wallet/domain.js";
import { authPolicy } from "../../plugins/authPolicy.js";

const ITEM_SCHEMA = { type: "object" as const, additionalProperties: true };
const DIFFICULTIES = ["easy", "normal", "hard", "critical"] as const;

function sessionTokenFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers["x-wallet-session"];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function requireWalletSession(
  store: CoordinatorStorePort,
  headers: Record<string, string | string[] | undefined>,
): Promise<WalletSessionRecord> {
  const token = sessionTokenFromRequest(headers);
  if (!token) throw forbidden("Wallet session is required");
  return ensureActiveWalletSession(
    await store.getProjection<WalletSessionRecord>(WALLET_SESSION, token),
    token,
  );
}

function candidateActorIds(session: WalletSessionRecord): string[] {
  const requested = session.requestedPrincipalId;
  const ids = [...new Set([
    ...(requested ? [requested] : []),
    ...session.agentBindings,
  ])];
  return ids.filter((id) => session.agentBindings.includes(id));
}

async function findAuthorizedObserverId(
  repo: CoordinationRepository,
  session: WalletSessionRecord,
  taskId: string,
): Promise<string> {
  const candidates = candidateActorIds(session);
  const observations = await repo.listObservations();
  for (const actorId of candidates) {
    const hasObservation = observations.some((observation) => {
      if (observation.submittedBy !== actorId) return false;
      if (observation.subjectRef?.id === taskId) return true;
      return observation.observationTaskId === taskId;
    });
    if (hasObservation) return actorId;
  }
  throw forbidden("Wallet session is not authorized to suggest a reward for this task");
}

async function findAuthorizedReviewerId(
  repo: ReviewRepository,
  session: WalletSessionRecord,
  taskId: string,
  taskStatus: string,
): Promise<string> {
  const candidates = candidateActorIds(session);
  const rounds = await repo.list();
  for (const actorId of candidates) {
    const round = rounds.find((item) => {
      const targetsTask = item.taskId === taskId || item.targetRef.id === taskId;
      const participates = item.reviewerIds.includes(actorId) || item.reviews.some((review) => review.reviewerId === actorId);
      return targetsTask && participates;
    });
    if (!round) continue;
    const taskPassing = taskStatus === "submitted" || taskStatus === "accepted";
    const reviewPassing = round.status === "in-review" || round.status === "completed" || round.outcome === "accepted";
    if (taskPassing || reviewPassing) return actorId;
  }
  throw forbidden("Wallet session is not authorized to approve a reward for this task");
}

const agentRewardsRoutes: FastifyPluginAsync = async (fastify) => {
  const rewards = () => new RewardRepository(fastify.coordinatorStore);
  const identities = () => new IdentityRepository(fastify.coordinatorStore);
  const work = () => new WorkRepository(fastify.coordinatorStore);
  const coordination = () => new CoordinationRepository(fastify.coordinatorStore);
  const reviews = () => new ReviewRepository(fastify.coordinatorStore);

  fastify.get<{ Querystring: { principalId?: string; chainId?: string; limit?: number } }>(
    "/agent-rewards",
    {
      ...authPolicy("public-read", {
        tags: ["Rewards"],
        summary: "List synced agent reward ledgers",
        querystring: {
          type: "object",
          properties: {
            principalId: { type: "string" },
            chainId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await rewards().listLedgers();
      if (req.query.principalId) items = items.filter((item) => item.principalId === req.query.principalId);
      if (req.query.chainId) items = items.filter((item) => item.chainId === req.query.chainId);
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.get<{ Params: { principalId: string } }>(
    "/agent-rewards/:principalId",
    {
      ...authPolicy("public-read", {
        tags: ["Rewards"],
        summary: "Get reward aggregate for a principal",
        params: { type: "object", required: ["principalId"], properties: { principalId: { type: "string" } } },
        response: { 200: envelopeKey("agentRewards", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const profile = await identities().getAgentProfile(req.params.principalId);
      if (!profile) throw notFound("AgentProfile", req.params.principalId);
      const ledgers = (await rewards().listLedgers()).filter((item) => item.principalId === req.params.principalId);
      const taskRewardHistory = (await rewards().listTaskRewardSettlements())
        .filter((item) => item.principalId === req.params.principalId)
        .sort((a, b) => (b.blockNumber ?? "").localeCompare(a.blockNumber ?? ""))
        .slice(0, 20);
      return ok({
        agentRewards: {
          principalId: req.params.principalId,
          agent: profile,
          summary: summarizeRewardLedgers(ledgers),
          rewardLedgers: ledgers,
          taskRewardHistory,
        },
      });
    },
  );

  fastify.get<{ Querystring: { limit?: number } }>(
    "/reward-days",
    {
      ...authPolicy("public-read", {
        tags: ["Rewards"],
        summary: "List reward day states synced from chain",
        querystring: { type: "object", properties: { limit: { type: "integer", default: 30 } } },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const items = (await rewards().listRewardDays())
        .sort((a, b) => b.dayIndex - a.dayIndex)
        .slice(0, req.query.limit ?? 30);
      return ok({ items });
    },
  );

  fastify.get<{ Querystring: { taskId?: string; principalId?: string; limit?: number } }>(
    "/task-rewards",
    {
      ...authPolicy("public-read", {
        tags: ["Rewards"],
        summary: "List task reward settlements synced from chain",
        querystring: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            principalId: { type: "string" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: { 200: envelopeKeyArray("items", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      let items = await rewards().listTaskRewardSettlements();
      if (req.query.taskId) items = items.filter((item) => item.taskId === req.query.taskId);
      if (req.query.principalId) items = items.filter((item) => item.principalId === req.query.principalId);
      items = items.sort((a, b) => (b.blockNumber ?? "").localeCompare(a.blockNumber ?? ""));
      return ok({ items: items.slice(0, req.query.limit ?? 50) });
    },
  );

  fastify.post<{
    Params: { taskId: string };
    Body: { difficulty: RewardDifficulty; rationale?: string };
  }>(
    "/tasks/:taskId/reward-suggestions",
    {
      ...authPolicy("wallet-session", {
        tags: ["Rewards"],
        summary: "Create a task reward difficulty suggestion",
        params: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["difficulty"],
          properties: {
            difficulty: { type: "string", enum: [...DIFFICULTIES] },
            rationale: { type: "string" },
          },
        },
        response: { 200: envelopeKey("rewardSuggestion", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const task = await work().getTask(req.params.taskId);
      if (!task) throw notFound("Task", req.params.taskId);
      const session = await requireWalletSession(fastify.coordinatorStore, req.headers as Record<string, string | string[] | undefined>);
      const observerId = await findAuthorizedObserverId(coordination(), session, req.params.taskId);
      const now = new Date().toISOString();
      const suggestion: TaskRewardSuggestion = {
        id: makeId("trs"),
        taskId: req.params.taskId,
        observerId,
        difficulty: req.body.difficulty,
        rationale: req.body.rationale,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      await rewards().saveTaskRewardSuggestion(suggestion);
      fastify.eventBus.publish(createEvent({
        type: "TaskRewardSuggested",
        payload: suggestion,
        actorId: observerId as never,
      }));
      return ok({ rewardSuggestion: suggestion });
    },
  );

  fastify.post<{
    Params: { taskId: string };
    Body: { approvedTaskRewardSuggestionId: string };
  }>(
    "/tasks/:taskId/approve-reward",
    {
      ...authPolicy("wallet-session", {
        tags: ["Rewards"],
        summary: "Approve a task reward suggestion",
        params: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["approvedTaskRewardSuggestionId"],
          properties: {
            approvedTaskRewardSuggestionId: { type: "string" },
          },
        },
        response: { 200: envelopeKey("taskRewardApproval", ITEM_SCHEMA) },
      }),
    },
    async (req) => {
      const task = await work().getTask(req.params.taskId);
      if (!task) throw notFound("Task", req.params.taskId);
      const session = await requireWalletSession(fastify.coordinatorStore, req.headers as Record<string, string | string[] | undefined>);
      const approvedBy = await findAuthorizedReviewerId(reviews(), session, req.params.taskId, task.status);
      const suggestion = await rewards().getTaskRewardSuggestion(req.body.approvedTaskRewardSuggestionId);
      if (!suggestion || suggestion.taskId !== req.params.taskId) {
        throw notFound("TaskRewardSuggestion", req.body.approvedTaskRewardSuggestionId);
      }
      if (suggestion.status !== "pending") throw badRequest(`TaskRewardSuggestion is already ${suggestion.status}`);

      const siblings = await rewards().listTaskRewardSuggestions(req.params.taskId);
      const now = new Date().toISOString();
      for (const sibling of siblings) {
        await rewards().saveTaskRewardSuggestion({
          ...sibling,
          status: sibling.id === suggestion.id ? "approved" : sibling.status === "pending" ? "superseded" : sibling.status,
          updatedAt: now,
        });
      }

      const approval: TaskRewardApproval = {
        id: `approval:${req.params.taskId}`,
        taskId: req.params.taskId,
        approvedTaskRewardSuggestionId: suggestion.id,
        difficulty: suggestion.difficulty,
        approvedBy,
        status: "approved",
        createdAt: now,
        updatedAt: now,
      };
      await rewards().saveTaskRewardApproval(approval);
      fastify.eventBus.publish(createEvent({
        type: "TaskRewardApproved",
        payload: approval,
        actorId: approvedBy as never,
      }));
      return ok({ taskRewardApproval: approval });
    },
  );
};

function summarizeRewardLedgers(ledgers: Array<{
  claimableTotal: string;
  claimedTotal: string;
  claimableBase: string;
  claimableObserver: string;
  claimableReviewer: string;
  claimableTask: string;
}>): {
  claimableTotal: string;
  claimedTotal: string;
  claimableBase: string;
  claimableObserver: string;
  claimableReviewer: string;
  claimableTask: string;
  ledgerCount: number;
} {
  return ledgers.reduce<{
    claimableTotal: string;
    claimedTotal: string;
    claimableBase: string;
    claimableObserver: string;
    claimableReviewer: string;
    claimableTask: string;
    ledgerCount: number;
  }>(
    (acc, ledger) => ({
      claimableTotal: addStrings(acc.claimableTotal, ledger.claimableTotal),
      claimedTotal: addStrings(acc.claimedTotal, ledger.claimedTotal),
      claimableBase: addStrings(acc.claimableBase, ledger.claimableBase),
      claimableObserver: addStrings(acc.claimableObserver, ledger.claimableObserver),
      claimableReviewer: addStrings(acc.claimableReviewer, ledger.claimableReviewer),
      claimableTask: addStrings(acc.claimableTask, ledger.claimableTask),
      ledgerCount: Number(acc.ledgerCount) + 1,
    }),
    {
      claimableTotal: "0",
      claimedTotal: "0",
      claimableBase: "0",
      claimableObserver: "0",
      claimableReviewer: "0",
      claimableTask: "0",
      ledgerCount: 0,
    },
  );
}

function addStrings(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

export default agentRewardsRoutes;
