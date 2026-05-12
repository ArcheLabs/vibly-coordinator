import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().default(8787),
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().default("file:./data/vibly-coordinator.sqlite"),
    STORAGE_MODE: z.enum(["memory", "sqlite", "postgres"]).default("sqlite"),
    COORDINATOR_ID: z.string().default("local-coordinator"),
    API_AUTH_MODE: z.enum(["none", "static-token", "oidc"]).default("static-token"),
    API_TOKENS: z.string().default("dev-token"),
    OIDC_ISSUER: z.string().optional(),
    OIDC_AUDIENCE: z.string().optional(),
    OIDC_JWKS_URL: z.string().optional(),
    OIDC_PROJECTS_CLAIM: z.string().default("vibly_projects"),
    SSE_HEARTBEAT_MS: z.coerce.number().default(15000),
    ASSIGNMENT_EXPIRY_INTERVAL_MS: z.coerce.number().default(0),
    TRACE_OUTPUT_DIR: z.string().default("./data/traces"),
    ENABLE_SWAGGER: z.string().transform((v) => v === "true").default("true"),
    ENABLE_DEV_ROUTES: z.string().transform((v) => v === "true").default("false"),
    GOVERNANCE_BACKENDS: z.string().default(""),
    SUBSTRATE_INDEXER_URL: z.string().optional(),
    SUBSTRATE_CHAIN_ID: z.string().default("substrate:vibly-solo"),
    SUBSTRATE_RPC_URL: z.string().default("ws://127.0.0.1:9944"),
    SUBSTRATE_GOVERNANCE_TX_MODE: z.enum(["prepare-only", "fixture", "unsafe-papi"]).default("prepare-only"),
    EVM_GOVERNOR_FIXTURE: z.string().transform((v) => v === "true").default("false"),
    EVM_CHAIN_ID: z.string().default("31337"),
    VIBLY_DOT_RECEIVING_ADDRESS: z.string().default(""),
    VIBLY_AIRDROP_DOMAIN: z.string().default("vibly.identity.airdrop"),
    VIBLY_CONVERSION_TOTAL_CAP: z.coerce.number().default(0),
    VIBLY_CONVERSION_INITIAL_RATE: z.coerce.number().default(1000),
    VIBLY_CONVERSION_SLOPE: z.coerce.number().default(0),
    VIBLY_CONVERSION_MIN_DOT: z.coerce.number().default(0.1),
    VIBLY_CONVERSION_MAX_DOT: z.coerce.number().default(1000),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== "production") return;

    if (val.STORAGE_MODE !== "postgres") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires STORAGE_MODE=postgres",
        path: ["STORAGE_MODE"],
      });
    }

    const db = val.DATABASE_URL.trim();
    if (!db.startsWith("postgres://") && !db.startsWith("postgresql://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production DATABASE_URL must be a postgres:// or postgresql:// URL",
        path: ["DATABASE_URL"],
      });
    }

    if (val.API_AUTH_MODE === "none" || val.API_AUTH_MODE === "static-token") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires API_AUTH_MODE=oidc (static-token/none are dev-only)",
        path: ["API_AUTH_MODE"],
      });
    }

    if (!val.OIDC_ISSUER?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "production requires OIDC_ISSUER", path: ["OIDC_ISSUER"] });
    }
    if (!val.OIDC_AUDIENCE?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires OIDC_AUDIENCE",
        path: ["OIDC_AUDIENCE"],
      });
    }
    const jwks = val.OIDC_JWKS_URL?.trim() ?? "";
    if (!jwks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires OIDC_JWKS_URL",
        path: ["OIDC_JWKS_URL"],
      });
    } else {
      try {
        new URL(jwks);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OIDC_JWKS_URL must be a valid URL",
          path: ["OIDC_JWKS_URL"],
        });
      }
    }

    if (val.ENABLE_DEV_ROUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production forbids ENABLE_DEV_ROUTES=true",
        path: ["ENABLE_DEV_ROUTES"],
      });
    }
  });

export interface CoordinatorConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  storageMode: "memory" | "sqlite" | "postgres";
  coordinatorId: string;
  apiAuthMode: "none" | "static-token" | "oidc";
  apiTokens: string[];
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcJwksUrl?: string;
  oidcProjectsClaim: string;
  sseHeartbeatMs: number;
  assignmentExpiryIntervalMs: number;
  traceOutputDir: string;
  enableSwagger: boolean;
  enableDevRoutes: boolean;
  governanceBackends: string[];
  substrateIndexerUrl?: string;
  substrateChainId: string;
  substrateRpcUrl: string;
  substrateGovernanceTxMode: "prepare-only" | "fixture" | "unsafe-papi";
  evmGovernorFixture: boolean;
  evmChainId: string;
  viblyDotReceivingAddress: string;
  viblyAirdropDomain: string;
  viblyConversionTotalCap: number;
  viblyConversionInitialRate: number;
  viblyConversionSlope: number;
  viblyConversionMinDot: number;
  viblyConversionMaxDot: number;
  otelExporterOtlpEndpoint?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  const parsed = envSchema.parse(env);
  const jwks = parsed.OIDC_JWKS_URL?.trim();
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
    oidcIssuer: parsed.OIDC_ISSUER?.trim() || undefined,
    oidcAudience: parsed.OIDC_AUDIENCE?.trim() || undefined,
    oidcJwksUrl: jwks || undefined,
    oidcProjectsClaim: parsed.OIDC_PROJECTS_CLAIM,
    sseHeartbeatMs: parsed.SSE_HEARTBEAT_MS,
    assignmentExpiryIntervalMs: parsed.ASSIGNMENT_EXPIRY_INTERVAL_MS,
    traceOutputDir: parsed.TRACE_OUTPUT_DIR,
    enableSwagger: parsed.ENABLE_SWAGGER,
    enableDevRoutes: parsed.ENABLE_DEV_ROUTES,
    governanceBackends: parsed.GOVERNANCE_BACKENDS.split(",").map((name) => name.trim()).filter(Boolean),
    substrateIndexerUrl: parsed.SUBSTRATE_INDEXER_URL,
    substrateChainId: parsed.SUBSTRATE_CHAIN_ID,
    substrateRpcUrl: parsed.SUBSTRATE_RPC_URL,
    substrateGovernanceTxMode: parsed.SUBSTRATE_GOVERNANCE_TX_MODE,
    evmGovernorFixture: parsed.EVM_GOVERNOR_FIXTURE,
    evmChainId: parsed.EVM_CHAIN_ID,
    viblyDotReceivingAddress: parsed.VIBLY_DOT_RECEIVING_ADDRESS,
    viblyAirdropDomain: parsed.VIBLY_AIRDROP_DOMAIN,
    viblyConversionTotalCap: parsed.VIBLY_CONVERSION_TOTAL_CAP,
    viblyConversionInitialRate: parsed.VIBLY_CONVERSION_INITIAL_RATE,
    viblyConversionSlope: parsed.VIBLY_CONVERSION_SLOPE,
    viblyConversionMinDot: parsed.VIBLY_CONVERSION_MIN_DOT,
    viblyConversionMaxDot: parsed.VIBLY_CONVERSION_MAX_DOT,
    otelExporterOtlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
  };
}
