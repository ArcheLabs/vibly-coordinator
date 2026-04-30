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
import assignmentsRoutes from "./modules/assignments/routes.js";
import streamsRoutes from "./modules/streams/routes.js";
import { GovernanceIndexConsumer } from "./services/governanceIndexConsumer.js";
import { GovernanceProjectorService } from "./services/governanceProjector.js";

// Extend FastifyInstance with our custom decorations
declare module "fastify" {
  interface FastifyInstance {
    concord: Concord;
    coordinatorStore: CoordinatorStore;
    eventBus: EventBus;
    config: CoordinatorConfig;
  }
}

export interface CreateAppOptions {
  config: CoordinatorConfig;
  logger: Logger;
  concord: Concord;
  coordinatorStore: CoordinatorStore;
  eventBus: EventBus;
}

export async function createApp(opts: CreateAppOptions): Promise<FastifyInstance> {
  const { config, logger, concord, coordinatorStore, eventBus } = opts;

  const fastify = Fastify({
    loggerInstance: logger,
    disableRequestLogging: config.nodeEnv === "test",
  });

  // Decorate with core services
  fastify.decorate("concord", concord);
  fastify.decorate("coordinatorStore", coordinatorStore);
  fastify.decorate("eventBus", eventBus);
  fastify.decorate("config", config);

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
  await fastify.register(assignmentsRoutes);
  await fastify.register(streamsRoutes);

  // Start governance index consumer if SUBSTRATE_INDEXER_URL is configured
  if (config.substrateIndexerUrl) {
    const { SubQueryGovernanceIndexAdapter } = await import("@concord/adapter-substrate-indexer");
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
    consumer.start();
    fastify.log.info({ indexerUrl: config.substrateIndexerUrl }, "GovernanceIndexConsumer started");
  }

  return fastify;
}
