import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { CoordinatorConfig } from "./config/env.js";
import type { Logger } from "./config/logger.js";
import type { Concord } from "@concord/sdk";
import type { EventEnvelope } from "@vibly-ai/concord-foundation";
import type { CoordinatorStorePort } from "./db/coordinatorStorePort.js";
import type { EventBus } from "./services/eventBus.js";

// Plugin imports
import errorHandlerPlugin from "./plugins/error-handler.js";
import authPlugin from "./plugins/auth.js";
import authorizationPlugin from "./plugins/authorization.js";
import versionPolicyPlugin from "./plugins/version-policy.js";
import corsPlugin from "./plugins/cors.js";
import swaggerPlugin from "./plugins/swagger.js";
import ssePlugin from "./plugins/sse.js";

// Domain module route imports (see modules/<domain>/… layout in AGENTS.md)
import healthRoutes from "./modules/platform/health/routes.js";
import networksRoutes from "./modules/platform/networks/routes.js";
import versionPolicyRoutes from "./modules/platform/version-policy/routes.js";
import metricsRoutes from "./modules/platform/metrics/routes.js";
import eventsRoutes from "./modules/platform/events/routes.js";
import streamsRoutes from "./modules/platform/streams/routes.js";

import contextRoutes from "./modules/knowledge/context/routes.js";
import stateRoutes from "./modules/knowledge/state/routes.js";
import knowledgeRoutes from "./modules/knowledge/knowledge/routes.js";
import observationsRoutes from "./modules/knowledge/observations/routes.js";

import principalsRoutes from "./modules/identity/principals/routes.js";
import agentsRoutes from "./modules/identity/agents/routes.js";
import agentProfileRoutes from "./api/routes/agentProfile.js";
import membershipsRoutes from "./modules/identity/memberships/routes.js";
import onboardingRoutes from "./modules/identity/onboarding/routes.js";
import walletRoutes from "./modules/identity/wallet/routes.js";
import agentEnrollmentsRoutes from "./modules/identity/agent-enrollments/routes.js";
import personalCenterRoutes from "./api/routes/personalCenter.js";
import adminAirdropRoutes from "./modules/admin/airdrop/routes.js";

import projectsRoutes from "./modules/project/projects/routes.js";
import objectivesRoutes from "./modules/project/objectives/routes.js";
import boundaryRoutes from "./modules/project/boundary/routes.js";
import projectReadModelRoutes from "./modules/project/read-models/routes.js";

import actionsRoutes from "./modules/workflow/actions/routes.js";
import negotiationsRoutes from "./modules/workflow/negotiations/routes.js";
import workRoutes from "./modules/workflow/work/routes.js";
import reviewsRoutes from "./modules/workflow/reviews/routes.js";
import tracesRoutes from "./modules/workflow/traces/routes.js";
import assignmentsRoutes from "./modules/workflow/assignments/routes.js";

import incentivesRoutes from "./modules/incentives/rewards/routes.js";
import reputationRoutes from "./modules/incentives/reputation/routes.js";
import riskRoutes from "./modules/incentives/risk/routes.js";
import guardianRoutes from "./modules/incentives/guardian/routes.js";

import governanceRoutes from "./modules/governance/routes.js";

import agentCollaborationScenarioRoutes from "./modules/dev/scenarios/agent-collaboration/routes.js";
import incentiveRiskScenarioRoutes from "./modules/dev/scenarios/incentive-risk/routes.js";

import { GovernanceIndexConsumer } from "./services/governanceIndexConsumer.js";
import { GovernanceProjectorService } from "./services/governanceProjector.js";
import { GovernanceBackendRegistry } from "./services/governanceBackendRegistry.js";

// v0.2 unified write path
import { ActionIntentDispatcher } from "./application/actionIntentDispatcher.js";
import actionIntentsRoutes from "./api/routes/actionIntents.js";
// v0.2 Organization context routes
import organizationsRoutes from "./api/routes/organizations.js";
// v0.2 Coordination context routes
import coordinationRoutes from "./api/routes/coordination.js";
// v0.2 Work / Artifact / Evaluation context routes
import workflowRoutes from "./api/routes/workflow.js";
// v0.2 Reputation / Settlement routes
import reputationV2Routes from "./api/routes/reputationV2.js";
// v0.2 Obligations + Agent Notifications
import obligationsRoutes from "./api/routes/obligations.js";
import agentNotificationsRoutes from "./api/routes/agentNotifications.js";
// v0.2 Public Library routes
import publicLibraryRoutes from "./api/routes/publicLibrary.js";
import agentRewardsRoutes from "./api/routes/agentRewards.js";
// v0.2 Guardian authority + membership
import authorityRoutes from "./api/routes/authority.js";
import { createChainAuthorityResolver } from "./services/chainAuthorityResolver.js";
// v0.2 Agent profile routes


declare module "fastify" {
  interface FastifyInstance {
    concord: Concord;
    coordinatorStore: CoordinatorStorePort;
    eventBus: EventBus;
    config: CoordinatorConfig;
    governanceBackendRegistry: GovernanceBackendRegistry;
  }
}

export interface CreateAppOptions {
  config: CoordinatorConfig;
  logger: Logger;
  concord: Concord;
  coordinatorStore: CoordinatorStorePort;
  eventBus: EventBus;
  startGovernanceConsumers?: boolean;
  readinessProbe?: () => Promise<void>;
  requestIdGenerator?: () => string;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const {
    config,
    logger,
    concord,
    coordinatorStore,
    eventBus,
    startGovernanceConsumers = true,
    readinessProbe,
    requestIdGenerator,
  } = opts;

  const fastify = Fastify({
    loggerInstance: logger,
    disableRequestLogging: config.nodeEnv === "test",
    genReqId: requestIdGenerator,
  });

  const governanceBackendRegistry = new GovernanceBackendRegistry();

  // ─── v0.2 write-path dispatcher (built up by application services below) ─
  const dispatcher = new ActionIntentDispatcher();
  // Chain authority resolver (Guardian membership, disabled by default)
  const authorityResolver = createChainAuthorityResolver(config);
  // Application services register their handlers here; imports are lazy so
  // future phases can add services without touching earlier ones.
  const { registerOrganizationHandlers } = await import("./application/organizationApplicationService.js");
  registerOrganizationHandlers(dispatcher);
  const { registerCoordinationHandlers } = await import("./application/coordinationApplicationService.js");
  registerCoordinationHandlers(dispatcher);
  const { registerWorkHandlers } = await import("./application/taskApplicationService.js");
  registerWorkHandlers(dispatcher);
  const { registerEvaluationHandlers } = await import("./application/evaluationApplicationService.js");
  registerEvaluationHandlers(dispatcher);
  const { registerSettlementHandlers } = await import("./application/settlementApplicationService.js");
  registerSettlementHandlers(dispatcher);

  startCoordinatorEventPersistence(eventBus, coordinatorStore, concord);

  // ─── v0.2 process managers (event-driven reactions) ───────────────────────
  const { startObservationAssignmentProcess } = await import("./process-managers/observationAssignmentProcess.js");
  startObservationAssignmentProcess(eventBus, coordinatorStore);

  const { startVotingRoundProcess, startVoteCountProcess } = await import("./process-managers/votingRoundProcess.js");
  startVotingRoundProcess(eventBus, coordinatorStore);
  startVoteCountProcess(eventBus, coordinatorStore);

  const { startProposalAcceptedProcess } = await import("./process-managers/proposalAcceptedProcess.js");
  startProposalAcceptedProcess(eventBus, coordinatorStore);

  const { startTaskSubmittedProcess } = await import("./process-managers/taskSubmittedProcess.js");
  startTaskSubmittedProcess(eventBus, coordinatorStore, config);

  const { startCoordinationRoundScheduler } = await import("./process-managers/coordinationRoundScheduler.js");
  const stopCoordinationRoundScheduler = startCoordinationRoundScheduler({
    config,
    store: coordinatorStore,
    eventBus,
  });

  const { startObservationTaskScheduler } = await import("./process-managers/observationTaskScheduler.js");
  startObservationTaskScheduler(eventBus, coordinatorStore, concord.projects);

  const { startRewardCreationProcess } = await import("./process-managers/rewardCreationProcess.js");
  startRewardCreationProcess(eventBus, coordinatorStore);

  const { startE2eCollaborationProcesses } = await import("./process-managers/e2eCollaborationProcesses.js");
  startE2eCollaborationProcesses(eventBus, coordinatorStore);

  const { startAssignmentExpiryScheduler } = await import("./process-managers/assignmentExpiryScheduler.js");
  const stopAssignmentExpiryScheduler = startAssignmentExpiryScheduler({
    intervalMs: config.assignmentExpiryIntervalMs,
    principalId: config.coordinatorId,
    dispatcher,
    store: coordinatorStore,
    eventBus,
    concord,
    config,
  });

  const { startAgentStakeReleaseProcess } = await import("./process-managers/agentStakeReleaseProcess.js");
  startAgentStakeReleaseProcess(eventBus, coordinatorStore, config);

  const { startOrganizationMembershipNotificationProcess } = await import("./process-managers/organizationMembershipNotificationProcess.js");
  startOrganizationMembershipNotificationProcess(eventBus, coordinatorStore);

  const { startAgentStakeIndexerSync } = await import("./services/agentStakeIndexerSync.js");
  const stopAgentStakeIndexerSync = startAgentStakeIndexerSync({
    config,
    dispatcher,
    store: coordinatorStore,
    eventBus,
    concord,
  });

  const { startChainIdentityIndexerSync } = await import("./services/chainIdentityIndexerSync.js");
  const stopChainIdentityIndexerSync = startChainIdentityIndexerSync({
    config,
    store: coordinatorStore,
  });

  const { startAgentRewardIndexerSync } = await import("./services/agentRewardIndexerSync.js");
  const stopAgentRewardIndexerSync = config.agentRewardEnabled
    ? startAgentRewardIndexerSync({
      config,
      store: coordinatorStore,
    })
    : () => {};

  const { startAgentRewardSettlementProcess } = await import("./process-managers/agentRewardSettlementProcess.js");
  const stopAgentRewardSettlementProcess = config.agentRewardEnabled
    ? startAgentRewardSettlementProcess(eventBus, coordinatorStore, config)
    : () => {};

  // ─── v0.2 projectors ──────────────────────────────────────────────────────
  const { startReputationProjector } = await import("./contexts/reputation/projector.js");
  startReputationProjector(eventBus, coordinatorStore);

  const { startPublicLibraryProjector } = await import("./contexts/library/projector.js");
  startPublicLibraryProjector(eventBus, coordinatorStore);

  fastify.decorate("concord", concord);
  fastify.decorate("coordinatorStore", coordinatorStore);
  fastify.decorate("eventBus", eventBus);
  fastify.decorate("config", config);
  fastify.decorate("governanceBackendRegistry", governanceBackendRegistry);

  await fastify.register(errorHandlerPlugin);
  await fastify.register(corsPlugin, { config });
  await fastify.register(swaggerPlugin, { config });
  await fastify.register(authPlugin, { config });
  await fastify.register(versionPolicyPlugin, { config });
  await fastify.register(authorizationPlugin, { config });
  await fastify.register(ssePlugin, { heartbeatMs: config.sseHeartbeatMs });
  fastify.addHook("onClose", async () => {
    stopAssignmentExpiryScheduler();
    stopAgentStakeIndexerSync();
    stopAgentRewardIndexerSync();
    stopChainIdentityIndexerSync();
    stopCoordinationRoundScheduler();
    stopAgentRewardSettlementProcess();
    await authorityResolver.close();
  });

  await fastify.register(healthRoutes, { config, readinessProbe });
  await fastify.register(networksRoutes, { config });
  await fastify.register(versionPolicyRoutes, { config });
  await fastify.register(metricsRoutes);
  await fastify.register(eventsRoutes);
  await fastify.register(streamsRoutes);

  // ─── v0.2 routes (new unified API) ────────────────────────────────────────
  await fastify.register(actionIntentsRoutes, { dispatcher, authorityResolver });
  await fastify.register(organizationsRoutes);
  await fastify.register(coordinationRoutes);
  await fastify.register(workflowRoutes);
  await fastify.register(reputationV2Routes);
  await fastify.register(obligationsRoutes);
  await fastify.register(agentNotificationsRoutes);
  await fastify.register(agentProfileRoutes);
  await fastify.register(personalCenterRoutes);
  await fastify.register(publicLibraryRoutes);
  await fastify.register(agentRewardsRoutes);
  await fastify.register(authorityRoutes, { authorityResolver });

  // ─── Legacy routes (deprecated, retained until Phase 5 cleanup) ───────────
  await fastify.register(projectsRoutes);
  await fastify.register(objectivesRoutes);
  await fastify.register(boundaryRoutes);
  await fastify.register(principalsRoutes);
  await fastify.register(agentsRoutes);
  await fastify.register(membershipsRoutes);
  await fastify.register(walletRoutes);
  await fastify.register(agentEnrollmentsRoutes);
  await fastify.register(onboardingRoutes);
  await fastify.register(adminAirdropRoutes);
  await fastify.register(contextRoutes);
  await fastify.register(stateRoutes);
  await fastify.register(knowledgeRoutes);
  await fastify.register(observationsRoutes);
  await fastify.register(actionsRoutes);
  await fastify.register(negotiationsRoutes);
  await fastify.register(workRoutes);
  await fastify.register(reviewsRoutes);
  await fastify.register(incentivesRoutes);
  await fastify.register(governanceRoutes);
  await fastify.register(tracesRoutes);
  await fastify.register(guardianRoutes);
  await fastify.register(reputationRoutes);
  await fastify.register(riskRoutes);
  await fastify.register(projectReadModelRoutes);
  await fastify.register(assignmentsRoutes);

  if (config.enableDevRoutes) {
    await fastify.register(agentCollaborationScenarioRoutes);
    await fastify.register(incentiveRiskScenarioRoutes);
  }

  if (isGovernanceBackendEnabled(config, "substrate-local", Boolean(config.substrateIndexerUrl)) && config.substrateIndexerUrl) {
    const { SubQueryGovernanceIndexAdapter } = await import("@vibly-ai/concord-adapter-substrate-indexer");
    const { defaultSubstrateCapabilities } = await import("@vibly-ai/concord-governance");
    const indexerAdapter = new SubQueryGovernanceIndexAdapter(config.substrateIndexerUrl);
    const projector = new GovernanceProjectorService();
    const consumer = new GovernanceIndexConsumer({
      store: coordinatorStore,
      feed: indexerAdapter.feed,
      chain: {
        namespace: "substrate",
        chainId: config.substrateChainId,
      },
      projector,
    });
    governanceBackendRegistry.register(
      {
        id: "substrate-local",
        backend: "substrate-opengov",
        chain: { namespace: "substrate", chainId: config.substrateChainId },
        displayName: `Substrate OpenGov (${config.substrateChainId})`,
        source: { kind: "subquery", endpoint: config.substrateIndexerUrl },
        capabilities: defaultSubstrateCapabilities(),
      },
      consumer,
    );
    fastify.log.info(
      { indexerUrl: config.substrateIndexerUrl },
      "Registered Substrate governance backend",
    );
  } else if (isGovernanceBackendEnabled(config, "substrate-local", false)) {
    fastify.log.warn(
      { backendId: "substrate-local" },
      "Skipped Substrate governance backend because SUBSTRATE_INDEXER_URL is not configured",
    );
  }

  if (isGovernanceBackendEnabled(config, "evm-fixture", config.evmGovernorFixture)) {
    const { EvmFixtureGovernanceIndexAdapter } = await import("@concord/adapter-evm-indexer");
    const { defaultEvmCapabilities } = await import("@vibly-ai/concord-governance");
    const evmChain = { namespace: "eip155" as const, chainId: config.evmChainId };
    const evmAdapter = new EvmFixtureGovernanceIndexAdapter();
    const projector = new GovernanceProjectorService();
    const consumer = new GovernanceIndexConsumer({
      store: coordinatorStore,
      feed: evmAdapter.feed,
      chain: evmChain,
      projector,
    });
    governanceBackendRegistry.register(
      {
        id: "evm-fixture",
        backend: "evm-governor",
        chain: evmChain,
        displayName: `EVM Governor (fixture, chainId=${config.evmChainId})`,
        source: { kind: "fixture" },
        capabilities: defaultEvmCapabilities(),
      },
      consumer,
    );
    fastify.log.info(
      { evmChainId: config.evmChainId },
      "Registered EVM fixture governance backend",
    );
  }

  if (startGovernanceConsumers) {
    governanceBackendRegistry.startAll();
  }

  return fastify as unknown as FastifyInstance;
}

function isGovernanceBackendEnabled(
  config: CoordinatorConfig,
  backendId: string,
  defaultEnabled: boolean,
): boolean {
  if (config.governanceBackends.length === 0) return defaultEnabled;
  return config.governanceBackends.includes(backendId);
}

function startCoordinatorEventPersistence(
  eventBus: EventBus,
  store: CoordinatorStorePort,
  concord: Concord,
): void {
  const projectNameCache = new Map<string, string>();

  eventBus.subscribe(async (event) => {
    try {
      await concord.state.events.append(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Event already exists") && !message.includes("UNIQUE constraint failed")) {
        console.error("[EventPersistence]", err);
      }
    }

    const scope = extractScope(event);
    if (!scope.organizationId) return;
    const projectName = scope.projectId
      ? await resolveProjectName(concord, projectNameCache, scope.projectId)
      : undefined;
      const feedItem = {
        feedEventId: event.id,
        eventType: event.type,
        networkId: scope.networkId,
        chainId: scope.networkId,
        organizationId: scope.organizationId,
      projectId: scope.projectId,
      projectName,
      actorId: typeof event.actorId === "string" ? event.actorId : undefined,
      subject: scope.subject,
      summary: buildFeedSummary(event, scope.subject?.type ?? scope.organizationId),
      payload: event.payload as Record<string, unknown>,
      createdAt: event.timestamp.iso,
    };
    try {
      await store.saveProjection("organization_feed_v2", feedItem.feedEventId, feedItem);
    } catch (err) {
      console.error("[FeedProjection]", err);
    }
  });
}

async function resolveProjectName(
  concord: Concord,
  cache: Map<string, string>,
  projectId: string,
): Promise<string | undefined> {
  const cached = cache.get(projectId);
  if (cached) return cached;
  try {
    const project = await concord.projects.getProject(projectId as never);
    const name = stringValue(project?.name);
    if (name) cache.set(projectId, name);
    return name;
  } catch {
    return undefined;
  }
}

function buildFeedSummary(event: EventEnvelope<string, unknown>, fallbackSubject: string): string {
  const payload = event.payload as Record<string, unknown>;
  const nested = (
    payload["observation"]
    ?? payload["proposal"]
    ?? payload["artifact"]
    ?? payload["task"]
    ?? payload["review"]
    ?? payload["outcome"]
    ?? payload["contribution"]
  ) as Record<string, unknown> | undefined;
  const source = nested ?? payload;
  const title = stringValue(source["title"])
    ?? stringValue(source["name"])
    ?? stringValue(source["summary"])
    ?? stringValue(source["body"])
    ?? stringValue(source["content"])
    ?? stringValue(source["description"])
    ?? stringValue(source["comment"]);
  if (title) return `${event.type}: ${truncate(title, 180)}`;
  return `${event.type} on ${fallbackSubject}`;
}

function extractScope(event: EventEnvelope<string, unknown>): {
  organizationId?: string;
  projectId?: string;
  networkId?: string;
  subject?: { type: string; id?: string };
} {
  const payload = event.payload as Record<string, unknown>;
  const nested = (
    payload["observation"]
    ?? payload["task"]
    ?? payload["artifact"]
    ?? payload["proposal"]
    ?? payload["rewardIntent"]
    ?? payload["batch"]
  ) as Record<string, unknown> | undefined;
  const source = nested ?? payload;
  const organizationId = stringValue(source["organizationId"]) ?? stringValue(payload["organizationId"]);
  const projectId = stringValue(source["projectId"]) ?? stringValue(payload["projectId"]);
  const networkId = stringValue(source["networkId"]) ?? stringValue(source["chainId"]) ?? stringValue(payload["networkId"]) ?? stringValue(payload["chainId"]);
  const id = stringValue(source["id"])
    ?? stringValue(payload["proposalId"])
    ?? stringValue(payload["taskId"])
    ?? stringValue(payload["artifactId"])
    ?? stringValue(payload["reviewRoundId"])
    ?? stringValue(payload["discussionId"]);

  return {
    organizationId,
    projectId,
    networkId,
    subject: { type: event.type.replace(/(Created|Submitted|Accepted|Rejected|Updated|Recorded|Started|Completed|Confirmed|Opened|Claimed|Requested|Selected)$/u, ""), id },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}
