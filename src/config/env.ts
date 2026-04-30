import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8787),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().default("file:./data/vibly-coordinator.sqlite"),
  STORAGE_MODE: z.enum(["memory", "sqlite"]).default("sqlite"),
  COORDINATOR_ID: z.string().default("local-coordinator"),
  API_AUTH_MODE: z.enum(["none", "static-token"]).default("static-token"),
  API_TOKENS: z.string().default("dev-token"),
  SSE_HEARTBEAT_MS: z.coerce.number().default(15000),
  TRACE_OUTPUT_DIR: z.string().default("./data/traces"),
  ENABLE_SWAGGER: z.string().transform((v) => v === "true").default("true"),
  ENABLE_DEV_ROUTES: z.string().transform((v) => v === "true").default("false"),
  GOVERNANCE_BACKENDS: z.string().default(""),
  SUBSTRATE_INDEXER_URL: z.string().optional(),
  SUBSTRATE_CHAIN_ID: z.string().default("substrate:vibly-solo"),
  EVM_GOVERNOR_FIXTURE: z.string().transform((v) => v === "true").default("false"),
  EVM_CHAIN_ID: z.string().default("31337"),
});

export interface CoordinatorConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  storageMode: "memory" | "sqlite";
  coordinatorId: string;
  apiAuthMode: "none" | "static-token";
  apiTokens: string[];
  sseHeartbeatMs: number;
  traceOutputDir: string;
  enableSwagger: boolean;
  enableDevRoutes: boolean;
  governanceBackends: string[];
  substrateIndexerUrl?: string;
  substrateChainId: string;
  evmGovernorFixture: boolean;
  evmChainId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  const parsed = envSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    storageMode: parsed.STORAGE_MODE,
    coordinatorId: parsed.COORDINATOR_ID,
    apiAuthMode: parsed.API_AUTH_MODE,
    apiTokens: parsed.API_TOKENS.split(",").map((t) => t.trim()).filter(Boolean),
    sseHeartbeatMs: parsed.SSE_HEARTBEAT_MS,
    traceOutputDir: parsed.TRACE_OUTPUT_DIR,
    enableSwagger: parsed.ENABLE_SWAGGER,
    enableDevRoutes: parsed.ENABLE_DEV_ROUTES,
    governanceBackends: parsed.GOVERNANCE_BACKENDS.split(",").map((name) => name.trim()).filter(Boolean),
    substrateIndexerUrl: parsed.SUBSTRATE_INDEXER_URL,
    substrateChainId: parsed.SUBSTRATE_CHAIN_ID,
    evmGovernorFixture: parsed.EVM_GOVERNOR_FIXTURE,
    evmChainId: parsed.EVM_CHAIN_ID,
  };
}
