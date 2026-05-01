import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { CoordinatorConfig } from "./config/env.js";
import type { Logger } from "./config/logger.js";
import type { Concord } from "@concord/sdk";
import type { CoordinatorStore } from "./db/coordinatorStore.js";
import type { EventBus } from "./services/eventBus.js";

// Plugin imports
import errorHandlerPlugin from "./plugins/error-handler.js";
import authPlugin from "./plugins/auth.js";
import corsPlugin from "./plugins/cors.js";
import swaggerPlugin from "./plugins/swagger.js";
import ssePlugin from "./plugins/sse.js";

// Module route imports
import healthRoutes from "./modules/health/routes.js";
import eventsRoutes from "./modules/events/routes.js";
import projectsRoutes from "./modules/projects/routes.js";
import objectivesRoutes from "./modules/objectives/routes.js";
import boundaryRoutes from "./modules/boundary/routes.js";
import principalsRoutes from "./modules/principals/routes.js";
import agentsRoutes from "./modules/agents/routes.js";
import membershipsRoutes from "./modules/memberships/routes.js";
import contextRoutes from "./modules/context/routes.js";
import stateRoutes from "./modules/state/routes.js";
import knowledgeRoutes from "./modules/knowledge/routes.js";
import observationsRoutes from "./modules/observations/routes.js";
import actionsRoutes from "./modules/actions/routes.js";
import negotiationsRoutes from "./modules/negotiations/routes.js";
import workRoutes from "./modules/work/routes.js";
import reviewsRoutes from "./modules/reviews/routes.js";
import incentivesRoutes from "./modules/incentives/routes.js";
import governanceRoutes from "./modules/governance/routes.js";
import tracesRoutes from "./modules/traces/routes.js";
import guardianRoutes from "./modules/guardian/routes.js";
import reputationRoutes from "./modules/reputation/routes.js";
import riskRoutes from "./modules/risk/routes.js";
import projectReadModelRoutes from "./modules/project-read-models/routes.js";
import assignmentsRoutes from "./modules/assignments/routes.js";
import streamsRoutes from "./modules/streams/routes.js";
import agentCollaborationScenarioRoutes from "./scenarios/agent-collaboration/routes.js";
import incentiveRiskScenarioRoutes from "./scenarios/incentive-risk/routes.js";
import { GovernanceIndexConsumer } from "./services/governanceIndexConsumer.js";
import { GovernanceProjectorService } from "./services/governanceProjector.js";
import { GovernanceBackendRegistry } from "./services/governanceBackendRegistry.js";

// Extend FastifyInstance with our custom decorations
declare module "fastify" {
  interface FastifyInstance {
    concord: Concord;
    coordinatorStore: CoordinatorStore;
    eventBus: EventBus;
    config: CoordinatorConfig;
    governanceBackendRegistry: GovernanceBackendRegistry;
  }
}

export interface CreateAppOptions {
  config: CoordinatorConfig;
  logger: Logger;
  concord: Concord;
  coordinatorStore: CoordinatorStore;
  eventBus: EventBus;
  startGovernanceConsumers?: boolean;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const { config, logger, concord, coordinatorStore, eventBus, startGovernanceConsumers = true } = opts;

  const fastify = Fastify({
    loggerInstance: logger,
    disableRequestLogging: config.nodeEnv === "test",
  });

  // Governance backend registry (always created, may be empty)
  const governanceBackendRegistry = new GovernanceBackendRegistry();

  // Decorate with core services
  fastify.decorate("concord", concord);
  fastify.decorate("coordinatorStore", coordinatorStore);
  fastify.decorate("eventBus", eventBus);
  fastify.decorate("config", config);
  fastify.decorate("governanceBackendRegistry", governanceBackendRegistry);

  // Plugins (order matters)
  await fastify.register(errorHandlerPlugin);
  await fastify.register(corsPlugin, { config });
  await fastify.register(swaggerPlugin, { config });
  await fastify.register(authPlugin, { config });
  await fastify.register(ssePlugin, { heartbeatMs: config.sseHeartbeatMs });

  // Routes
  await fastify.register(healthRoutes, { config });
  await fastify.register(eventsRoutes);
  await fastify.register(projectsRoutes);
  await fastify.register(objectivesRoutes);
  await fastify.register(boundaryRoutes);
  await fastify.register(principalsRoutes);
  await fastify.register(agentsRoutes);
  await fastify.register(membershipsRoutes);
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
  await fastify.register(streamsRoutes);
  await fastify.register(agentCollaborationScenarioRoutes);
  await fastify.register(incentiveRiskScenarioRoutes);

  // ─── Register Substrate backend ─────────────────────────────────────────────
  if (isGovernanceBackendEnabled(config, "substrate-local", Boolean(config.substrateIndexerUrl)) && config.substrateIndexerUrl) {
    const { SubQueryGovernanceIndexAdapter } = await import("@concord/adapter-substrate-indexer");
    const { defaultSubstrateCapabilities } = await import("@concord/governance");
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

  // ─── Register EVM fixture backend ───────────────────────────────────────────
  if (isGovernanceBackendEnabled(config, "evm-fixture", config.evmGovernorFixture)) {
    const { EvmFixtureGovernanceIndexAdapter } = await import("@concord/adapter-evm-indexer");
    const { defaultEvmCapabilities } = await import("@concord/governance");
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

  // Start all registered backends
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
