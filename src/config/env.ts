import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envSchema = z
  .object({
    // ─────────────────────────────────────────────────────────────────────────
    // Runtime / server basics
    // ─────────────────────────────────────────────────────────────────────────
    // Runtime mode. Production enables extra safety checks in superRefine.
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Fastify bind host.
    HOST: z.string().default("0.0.0.0"),
    // Fastify listen port.
    PORT: z.coerce.number().default(8787),
    // Pino/Fastify log level.
    LOG_LEVEL: z.string().default("info"),
    // Comma-separated browser origins allowed to call Coordinator directly.
    // Required for static Console deployments; leave empty to disable production CORS.
    CORS_ALLOWED_ORIGINS: z.string().default(""),

    // ─────────────────────────────────────────────────────────────────────────
    // Storage / persistence
    // ─────────────────────────────────────────────────────────────────────────
    // Connection string. In sqlite mode this is usually file:./data/*.sqlite.
    DATABASE_URL: z.string().default("file:./data/vibly-coordinator.sqlite"),
    // Storage backend switch:
    // - memory: ephemeral process memory (tests/local demos)
    // - sqlite: local durable file database (default dev mode)
    // - postgres: production-grade shared persistence
    STORAGE_MODE: z.enum(["memory", "sqlite", "postgres"]).default("sqlite"),
    // Logical coordinator node identity used in logs/metadata.
    COORDINATOR_ID: z.string().default("local-coordinator"),

    // ─────────────────────────────────────────────────────────────────────────
    // API auth / OIDC
    // ─────────────────────────────────────────────────────────────────────────
    // Development may disable auth entirely. Hosted environments use static service tokens
    // for protected non-wallet routes, while user writes authenticate with wallet sessions.
    API_AUTH_MODE: z.enum(["none", "static-token"]).default("static-token"),
    // Comma-separated tokens used when API_AUTH_MODE=static-token.
    API_TOKENS: z.string().default("dev-token"),

    // ─────────────────────────────────────────────────────────────────────────
    // Background loops / infra toggles
    // ─────────────────────────────────────────────────────────────────────────
    // SSE heartbeat interval for stream keepalive.
    SSE_HEARTBEAT_MS: z.coerce.number().default(15000),
    // Assignment expiry scheduler interval; 0 means disabled.
    ASSIGNMENT_EXPIRY_INTERVAL_MS: z.coerce.number().default(0),
    // Stake sync scheduler interval; 0 means disabled.
    AGENT_STAKE_SYNC_INTERVAL_MS: z.coerce.number().default(0),
    // Agent reward sync/settlement production controls.
    AGENT_REWARD_ENABLED: z.string().transform((v) => v === "true").default("false"),
    AGENT_REWARD_SYNC_INTERVAL_MS: z.coerce.number().default(0),
    AGENT_REWARD_SETTLEMENT_INTERVAL_MS: z.coerce.number().default(0),
    AGENT_REWARD_TX_MODE: z.enum(["prepare-only", "fixture", "unsafe-papi"]).default("prepare-only"),
    AGENT_REWARD_PUBLISHER_URI: z.string().default(""),
    AGENT_REWARD_EMISSION_START_AT: z.string().default(""),
    AGENT_REWARD_MAX_CATCHUP_DAYS: z.coerce.number().int().min(1).default(7),
    LEGACY_REWARD_INTENT_MODE: z.enum(["hidden", "disabled", "enabled"]).default("hidden"),
    // Get VIB root upload scheduler interval; 0 means disabled.
    GET_VIB_ROOT_UPLOAD_INTERVAL_MS: z.coerce.number().default(120000),
    // Get VIB root upload tx mode.
    GET_VIB_ROOT_UPLOAD_MODE: z.enum(["prepare-only", "fixture", "unsafe-papi"]).default("prepare-only"),
    // Dedicated least-privilege hot key authorized on-chain only for vibClaim.setClaimRoot.
    GET_VIB_ROOT_PUBLISHER_URI: z.string().default(""),
    // Explicit production gate for on-chain VIB claims. Keep false until Vibly Chain is live
    // and a claim root has been uploaded.
    GET_VIB_CLAIM_ENABLED: z.string().transform((v) => v === "true").default("false"),
    // Maximum acceptable staleness for cached stake data.
    AGENT_STAKE_FRESHNESS_MS: z.coerce.number().default(30000),
    // Local trace output path for debug/event traces.
    TRACE_OUTPUT_DIR: z.string().default("./data/traces"),
    // OpenAPI/swagger exposure toggle.
    ENABLE_SWAGGER: z.string().transform((v) => v === "true").default("true"),
    // Enables dev-only routes; forbidden in production.
    ENABLE_DEV_ROUTES: z.string().transform((v) => v === "true").default("false"),

    // ─────────────────────────────────────────────────────────────────────────
    // Governance backend integrations
    // ─────────────────────────────────────────────────────────────────────────
    // Comma-separated backend names, e.g. "evm,substrate".
    GOVERNANCE_BACKENDS: z.string().default(""),
    SUBSTRATE_INDEXER_URL: z.string().optional(),
    SUBSTRATE_CHAIN_ID: z.string().default("substrate:vibly-solo"),
    SUBSTRATE_RPC_URL: z.string().default("ws://127.0.0.1:9944"),
    SUBSTRATE_GOVERNANCE_TX_MODE: z.enum(["prepare-only", "fixture", "unsafe-papi"]).default("prepare-only"),
    SUBSTRATE_STAKE_TX_MODE: z.enum(["prepare-only", "fixture", "unsafe-papi"]).default("prepare-only"),
    SUBSTRATE_COORDINATOR_AUTHORITY_URI: z.string().default("//Alice"),
    EVM_GOVERNOR_FIXTURE: z.string().transform((v) => v === "true").default("false"),
    EVM_CHAIN_ID: z.string().default("31337"),

    // ─────────────────────────────────────────────────────────────────────────
    // Dot/VIB conversion settings
    // ─────────────────────────────────────────────────────────────────────────
    VIBLY_DOT_RECEIVING_ADDRESS: z.string().default(""),
    VIBLY_AIRDROP_DOMAIN: z.string().default("vibly.identity.airdrop"),
    VIBLY_CONVERSION_TOTAL_CAP: z.coerce.number().default(0),
    VIBLY_CONVERSION_INITIAL_RATE: z.coerce.number().default(1000),
    VIBLY_CONVERSION_SLOPE: z.coerce.number().default(0),
    VIBLY_CONVERSION_MIN_DOT: z.coerce.number().default(0.1),
    GET_VIB_RELAY_RPC_URL: z.string().optional(),
    GET_VIB_RELAY_CHAIN_ID: z.string().default("polkadot-dev"),
    GET_VIB_RELAY_TOKEN_SYMBOL: z.string().default(""),
    GET_VIB_RELAY_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(30).default(10),
    GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: z.coerce.number().default(0),
    GET_VIB_DEPOSIT_START_BLOCK: z.coerce.number().int().min(0).default(0),
    GET_VIB_DEPOSIT_FINALITY_BLOCKS: z.coerce.number().int().min(0).default(0),
    GET_VIB_CURVE_PAUSED: z.string().transform((v) => v === "true").default("false"),

    // ─────────────────────────────────────────────────────────────────────────
    // Observability
    // ─────────────────────────────────────────────────────────────────────────
    // Optional OTLP endpoint for telemetry export.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // ─── Coordination scheduling ──────────────────────────────────────────────
    // Total round duration in ms.
    // Set to 0 to disable the coordination round scheduler entirely.
    VIBLY_COORDINATION_ROUND_INTERVAL_MS: z.coerce.number().default(600000),
    // Observation submission deadline as a ratio of round duration.
    // Example: interval=10min and ratio=0.5 -> submit deadline at +5min.
    OBSERVATION_SUBMIT_RATIO: z.coerce.number().min(0.1).max(0.9).default(0.5),
    // Hard cap on reviewers selected per cycle (global safety bound).
    GLOBAL_MAX_REVIEWERS_PER_CYCLE: z.coerce.number().min(1).default(5),
    // Max number of review cycles allowed per review round.
    MAX_REVIEW_CYCLES: z.coerce.number().min(1).default(5),
    // Duration of one review cycle in ms.
    REVIEW_CYCLE_INTERVAL_MS: z.coerce.number().default(300000),
    // Review deadline fallback in ms (used by review-related flows).
    REVIEW_DEADLINE_MS: z.coerce.number().default(300000),

    // ─────────────────────────────────────────────────────────────────────────
    // Chain authority resolver
    // ─────────────────────────────────────────────────────────────────────────
    // Which mode to use for Guardian membership checks.
    // disabled: always returns isGuardian=false (safe default).
    // rpc: queries chain via WebSocket RPC using @polkadot/api.
    CHAIN_AUTHORITY_MODE: z.enum(["rpc", "disabled"]).default("disabled"),
    // WebSocket URL for the chain RPC. Falls back to SUBSTRATE_RPC_URL.
    CHAIN_AUTHORITY_RPC_URL: z.string().default(""),
    // Chain ID used for authority decisions.
    CHAIN_AUTHORITY_CHAIN_ID: z.string().default("substrate:vibly-solo"),
    // How long (ms) to cache a successful Guardian snapshot before re-querying.
    CHAIN_AUTHORITY_CACHE_TTL_MS: z.coerce.number().default(60000),
    // Number of blocks after which a cached snapshot is considered stale.
    CHAIN_AUTHORITY_MAX_STALENESS_BLOCKS: z.coerce.number().default(50),
    // Who can perform privileged organization management:
    // guardian = chain Guardian required; local = no chain check (dev default).
    ORG_ADMIN_AUTHORITY_SOURCE: z.enum(["guardian", "local"]).default("local"),
    // Minimum active stake (as bigint string) required to join an organization.
    // "0" disables the stake requirement.
    ORG_MEMBERSHIP_MIN_ACTIVE_STAKE: z.string().default("0"),

    // ─────────────────────────────────────────────────────────────────────────
    // Agent connectivity / retry
    // ─────────────────────────────────────────────────────────────────────────
    // Max reconnect attempts before giving up.
    AGENT_RECONNECT_MAX_ATTEMPTS: z.coerce.number().default(5),
    // Exponential backoff base delay (ms).
    AGENT_RECONNECT_BASE_DELAY_MS: z.coerce.number().default(1000),
    // Exponential backoff max delay ceiling (ms).
    AGENT_RECONNECT_MAX_DELAY_MS: z.coerce.number().default(30000),
    // Debounce window to avoid connect/disconnect flapping (ms).
    AGENT_CONNECTION_DEBOUNCE_MS: z.coerce.number().default(5000),

    // ─────────────────────────────────────────────────────────────────────────
    // Client version policy / upgrade gates
    // ─────────────────────────────────────────────────────────────────────────
    CLIENT_VERSION_ENFORCEMENT: z.string().transform((v) => v === "true").default("false"),
    MINIMUM_CLIENT_VERSION: z.string().default("0.1.0"),
    RECOMMENDED_CLIENT_VERSION: z.string().default("0.1.0"),
    MINIMUM_CONTRACT_VERSION: z.string().default("0.1.0"),
    UPGRADE_DEADLINE: z.string().optional(),
    UPGRADE_INSTRUCTIONS_URL: z.string().default("https://docs.vibly.dev/agent/upgrade"),
    PROTOCOL_VERSION: z.string().default("2026-06-01"),
    NETWORK_MANIFEST_FILE: z.string().default(""),
    NETWORK_MANIFEST_JSON: z.string().default(""),
  })
  .superRefine((val, ctx) => {
    const manifestInput = readNetworkManifestInput(val);
    let manifests: unknown = manifestInput.parsed;
    if (manifestInput.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: manifestInput.error,
        path: [manifestInput.path],
      });
    }

    if (val.GET_VIB_ROOT_UPLOAD_MODE === "unsafe-papi" && !val.GET_VIB_ROOT_PUBLISHER_URI.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GET_VIB_ROOT_UPLOAD_MODE=unsafe-papi requires GET_VIB_ROOT_PUBLISHER_URI",
        path: ["GET_VIB_ROOT_PUBLISHER_URI"],
      });
    }

    if (val.NODE_ENV === "production" && val.GET_VIB_CLAIM_ENABLED && val.GET_VIB_ROOT_UPLOAD_MODE !== "unsafe-papi") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GET_VIB_CLAIM_ENABLED=true requires GET_VIB_ROOT_UPLOAD_MODE=unsafe-papi",
        path: ["GET_VIB_ROOT_UPLOAD_MODE"],
      });
    }

    if (val.AGENT_REWARD_ENABLED) {
      if (!val.SUBSTRATE_INDEXER_URL?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AGENT_REWARD_ENABLED=true requires SUBSTRATE_INDEXER_URL",
          path: ["SUBSTRATE_INDEXER_URL"],
        });
      }
      if (!val.SUBSTRATE_RPC_URL.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AGENT_REWARD_ENABLED=true requires SUBSTRATE_RPC_URL",
          path: ["SUBSTRATE_RPC_URL"],
        });
      }
      const startAt = val.AGENT_REWARD_EMISSION_START_AT.trim();
      if (!startAt || !Number.isFinite(Date.parse(startAt))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AGENT_REWARD_ENABLED=true requires AGENT_REWARD_EMISSION_START_AT as an ISO timestamp",
          path: ["AGENT_REWARD_EMISSION_START_AT"],
        });
      }
    }

    if (val.AGENT_REWARD_TX_MODE === "unsafe-papi" && !val.AGENT_REWARD_PUBLISHER_URI.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AGENT_REWARD_TX_MODE=unsafe-papi requires AGENT_REWARD_PUBLISHER_URI",
        path: ["AGENT_REWARD_PUBLISHER_URI"],
      });
    }

    if (manifestInput.raw.trim()) {
      if (manifests !== undefined && !Array.isArray(manifests)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${manifestInput.path} must be a JSON array`,
          path: [manifestInput.path],
        });
      }
      if (val.NODE_ENV === "production" && Array.isArray(manifests)) {
        for (const [index, manifest] of manifests.entries()) {
          const record = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>) : {};
          const features = record.features && typeof record.features === "object" ? (record.features as Record<string, unknown>) : undefined;
          const coordinatorUrls = Array.isArray(record.coordinatorUrls) ? record.coordinatorUrls.filter((item) => typeof item === "string" && item.trim()) : [];
          if (!coordinatorUrls.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `production network manifest[${index}] requires coordinatorUrls`,
              path: [manifestInput.path],
            });
          }
          if (!record.stage || !record.status || !features) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `production network manifest[${index}] requires stage, status, and features`,
              path: [manifestInput.path],
            });
          }
        }
      }
    }

    if (val.NODE_ENV !== "production") return;

    const getVibConversionRequested = hasManifestFeature(manifests, "getVibConversion");
    const getVibClaimRequested = val.GET_VIB_CLAIM_ENABLED || hasManifestFeature(manifests, "getVibClaim");
    if (getVibConversionRequested) {
      if (!val.VIBLY_DOT_RECEIVING_ADDRESS.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB conversion requires VIBLY_DOT_RECEIVING_ADDRESS",
          path: ["VIBLY_DOT_RECEIVING_ADDRESS"],
        });
      }
      if (!val.GET_VIB_RELAY_RPC_URL?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB conversion requires GET_VIB_RELAY_RPC_URL",
          path: ["GET_VIB_RELAY_RPC_URL"],
        });
      }
      if (val.GET_VIB_RELAY_CHAIN_ID !== "polkadot" && val.GET_VIB_RELAY_CHAIN_ID !== "paseo") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB conversion requires GET_VIB_RELAY_CHAIN_ID=polkadot (mainnet) or =paseo (testnet)",
          path: ["GET_VIB_RELAY_CHAIN_ID"],
        });
      }
      if (val.GET_VIB_RELAY_TOKEN_DECIMALS !== 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB conversion requires GET_VIB_RELAY_TOKEN_DECIMALS=10 for Polkadot DOT",
          path: ["GET_VIB_RELAY_TOKEN_DECIMALS"],
        });
      }
      if (val.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB conversion requires GET_VIB_DEPOSIT_SCAN_INTERVAL_MS > 0",
          path: ["GET_VIB_DEPOSIT_SCAN_INTERVAL_MS"],
        });
      }
      if (val.GET_VIB_DEPOSIT_FINALITY_BLOCKS <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB conversion requires GET_VIB_DEPOSIT_FINALITY_BLOCKS > 0",
          path: ["GET_VIB_DEPOSIT_FINALITY_BLOCKS"],
        });
      }
    }

    if (getVibClaimRequested) {
      if (!val.GET_VIB_CLAIM_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production manifest getVibClaim=true requires GET_VIB_CLAIM_ENABLED=true",
          path: ["GET_VIB_CLAIM_ENABLED"],
        });
      }
      if (!manifestViblyChainOnline(manifests)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB claim requires an online Vibly chain in the network manifest",
          path: [manifestInput.path],
        });
      }
      if (!val.SUBSTRATE_RPC_URL.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB claim requires SUBSTRATE_RPC_URL",
          path: ["SUBSTRATE_RPC_URL"],
        });
      }
      if (!val.GET_VIB_ROOT_PUBLISHER_URI.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "production Get VIB claim requires GET_VIB_ROOT_PUBLISHER_URI",
          path: ["GET_VIB_ROOT_PUBLISHER_URI"],
        });
      }
    }

    if (!manifestInput.raw.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires NETWORK_MANIFEST_FILE or NETWORK_MANIFEST_JSON",
        path: [manifestInput.path],
      });
    }

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

    if (val.API_AUTH_MODE !== "static-token") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires API_AUTH_MODE=static-token",
        path: ["API_AUTH_MODE"],
      });
    }
    const apiTokens = val.API_TOKENS.split(",").map((item) => item.trim()).filter(Boolean);
    if (apiTokens.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires at least one API token in API_TOKENS",
        path: ["API_TOKENS"],
      });
    }
    if (apiTokens.some((token) => token === "dev-token")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production forbids the default API_TOKENS value dev-token",
        path: ["API_TOKENS"],
      });
    }

    const corsOrigins = val.CORS_ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
    for (const origin of corsOrigins) {
      try {
        new URL(origin);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "CORS_ALLOWED_ORIGINS must be a comma-separated list of valid origins",
          path: ["CORS_ALLOWED_ORIGINS"],
        });
      }
    }

    if (val.ORG_ADMIN_AUTHORITY_SOURCE !== "guardian") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production organization administration requires ORG_ADMIN_AUTHORITY_SOURCE=guardian",
        path: ["ORG_ADMIN_AUTHORITY_SOURCE"],
      });
    }

    if (val.CHAIN_AUTHORITY_MODE !== "rpc") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production Guardian authority checks require CHAIN_AUTHORITY_MODE=rpc",
        path: ["CHAIN_AUTHORITY_MODE"],
      });
    }

    if (val.ENABLE_DEV_ROUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production forbids ENABLE_DEV_ROUTES=true",
        path: ["ENABLE_DEV_ROUTES"],
      });
    }

    if (!val.CLIENT_VERSION_ENFORCEMENT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "production requires CLIENT_VERSION_ENFORCEMENT=true",
        path: ["CLIENT_VERSION_ENFORCEMENT"],
      });
    }
  });

export interface CoordinatorConfig {
  // ─── Runtime / server basics ─────────────────────────────────────────────
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  corsAllowedOrigins: string[];

  // ─── Storage / persistence ───────────────────────────────────────────────
  databaseUrl: string;
  storageMode: "memory" | "sqlite" | "postgres";
  coordinatorId: string;

  // ─── API auth / OIDC ─────────────────────────────────────────────────────
  apiAuthMode: "none" | "static-token";
  apiTokens: string[];

  // ─── Background loops / infra toggles ───────────────────────────────────
  sseHeartbeatMs: number;
  assignmentExpiryIntervalMs: number;
  agentStakeSyncIntervalMs: number;
  agentRewardEnabled: boolean;
  agentRewardSyncIntervalMs: number;
  agentRewardSettlementIntervalMs: number;
  agentRewardTxMode: "prepare-only" | "fixture" | "unsafe-papi";
  agentRewardPublisherUri?: string;
  agentRewardEmissionStartAt?: string;
  agentRewardMaxCatchupDays: number;
  legacyRewardIntentMode: "hidden" | "disabled" | "enabled";
  getVibRootUploadIntervalMs: number;
  getVibRootUploadMode: "prepare-only" | "fixture" | "unsafe-papi";
  getVibRootPublisherUri?: string;
  getVibClaimEnabled: boolean;
  agentStakeFreshnessMs: number;
  traceOutputDir: string;
  enableSwagger: boolean;
  enableDevRoutes: boolean;

  // ─── Governance backend integrations ─────────────────────────────────────
  governanceBackends: string[];
  substrateIndexerUrl?: string;
  substrateChainId: string;
  substrateRpcUrl: string;
  substrateGovernanceTxMode: "prepare-only" | "fixture" | "unsafe-papi";
  substrateStakeTxMode: "prepare-only" | "fixture" | "unsafe-papi";
  substrateCoordinatorAuthorityUri: string;
  evmGovernorFixture: boolean;
  evmChainId: string;

  // ─── Dot/VIB conversion settings ─────────────────────────────────────────
  viblyDotReceivingAddress: string;
  viblyAirdropDomain: string;
  viblyConversionTotalCap: number;
  viblyConversionInitialRate: number;
  viblyConversionSlope: number;
  viblyConversionMinDot: number;
  getVibRelayRpcUrl?: string;
  getVibRelayChainId: string;
  getVibRelayTokenSymbol?: string;
  getVibRelayTokenDecimals: number;
  getVibDepositScanIntervalMs: number;
  getVibDepositStartBlock: number;
  getVibDepositFinalityBlocks: number;
  getVibCurvePaused: boolean;

  // ─── Observability ────────────────────────────────────────────────────────
  otelExporterOtlpEndpoint?: string;

  // ─── Coordination scheduling ──────────────────────────────────────────────
  viblyCoordinationRoundIntervalMs: number;
  observationSubmitRatio: number;
  globalMaxReviewersPerCycle: number;
  maxReviewCycles: number;
  reviewCycleIntervalMs: number;
  reviewDeadlineMs: number;
  agentReconnectMaxAttempts: number;
  agentReconnectBaseDelayMs: number;
  agentReconnectMaxDelayMs: number;
  agentConnectionDebounceMs: number;

  // ─── Client version policy / upgrade gates ───────────────────────────────
  clientVersionEnforcement: boolean;
  minimumClientVersion: string;
  recommendedClientVersion: string;
  minimumContractVersion: string;
  upgradeDeadline?: string;
  upgradeInstructionsUrl: string;
  protocolVersion: string;
  networkManifestJson?: string;
  networkManifestFile?: string;

  // ─── Chain authority resolver ─────────────────────────────────────────────
  chainAuthorityMode: "rpc" | "disabled";
  chainAuthorityRpcUrl: string;
  chainAuthorityChainId: string;
  chainAuthorityCacheTtlMs: number;
  chainAuthorityMaxStalenessBlocks: number;
  orgAdminAuthoritySource: "guardian" | "local";
  orgMembershipMinActiveStake: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorConfig {
  const parsed = envSchema.parse(env);
  const manifestInput = readNetworkManifestInput(parsed);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    corsAllowedOrigins: parsed.CORS_ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    databaseUrl: parsed.DATABASE_URL,
    storageMode: parsed.STORAGE_MODE,
    coordinatorId: parsed.COORDINATOR_ID,
    apiAuthMode: parsed.API_AUTH_MODE,
    apiTokens: parsed.API_TOKENS.split(",").map((t) => t.trim()).filter(Boolean),
    sseHeartbeatMs: parsed.SSE_HEARTBEAT_MS,
    assignmentExpiryIntervalMs: parsed.ASSIGNMENT_EXPIRY_INTERVAL_MS,
    agentStakeSyncIntervalMs: parsed.AGENT_STAKE_SYNC_INTERVAL_MS,
    agentRewardEnabled: parsed.AGENT_REWARD_ENABLED,
    agentRewardSyncIntervalMs: parsed.AGENT_REWARD_SYNC_INTERVAL_MS,
    agentRewardSettlementIntervalMs: parsed.AGENT_REWARD_SETTLEMENT_INTERVAL_MS,
    agentRewardTxMode: parsed.AGENT_REWARD_TX_MODE,
    agentRewardPublisherUri: parsed.AGENT_REWARD_PUBLISHER_URI.trim() || undefined,
    agentRewardEmissionStartAt: parsed.AGENT_REWARD_EMISSION_START_AT.trim() || undefined,
    agentRewardMaxCatchupDays: parsed.AGENT_REWARD_MAX_CATCHUP_DAYS,
    legacyRewardIntentMode: parsed.LEGACY_REWARD_INTENT_MODE,
    getVibRootUploadIntervalMs: parsed.GET_VIB_ROOT_UPLOAD_INTERVAL_MS,
    getVibRootUploadMode: parsed.GET_VIB_ROOT_UPLOAD_MODE,
    getVibRootPublisherUri: parsed.GET_VIB_ROOT_PUBLISHER_URI.trim() || undefined,
    getVibClaimEnabled: parsed.GET_VIB_CLAIM_ENABLED,
    agentStakeFreshnessMs: parsed.AGENT_STAKE_FRESHNESS_MS,
    traceOutputDir: parsed.TRACE_OUTPUT_DIR,
    enableSwagger: parsed.ENABLE_SWAGGER,
    enableDevRoutes: parsed.ENABLE_DEV_ROUTES,
    governanceBackends: parsed.GOVERNANCE_BACKENDS.split(",").map((name) => name.trim()).filter(Boolean),
    substrateIndexerUrl: parsed.SUBSTRATE_INDEXER_URL,
    substrateChainId: parsed.SUBSTRATE_CHAIN_ID,
    substrateRpcUrl: parsed.SUBSTRATE_RPC_URL,
    substrateGovernanceTxMode: parsed.SUBSTRATE_GOVERNANCE_TX_MODE,
    substrateStakeTxMode: parsed.SUBSTRATE_STAKE_TX_MODE,
    substrateCoordinatorAuthorityUri: parsed.SUBSTRATE_COORDINATOR_AUTHORITY_URI,
    evmGovernorFixture: parsed.EVM_GOVERNOR_FIXTURE,
    evmChainId: parsed.EVM_CHAIN_ID,
    viblyDotReceivingAddress: parsed.VIBLY_DOT_RECEIVING_ADDRESS,
    viblyAirdropDomain: parsed.VIBLY_AIRDROP_DOMAIN,
    viblyConversionTotalCap: parsed.VIBLY_CONVERSION_TOTAL_CAP,
    viblyConversionInitialRate: parsed.VIBLY_CONVERSION_INITIAL_RATE,
    viblyConversionSlope: parsed.VIBLY_CONVERSION_SLOPE,
    viblyConversionMinDot: parsed.VIBLY_CONVERSION_MIN_DOT,
    getVibRelayRpcUrl: parsed.GET_VIB_RELAY_RPC_URL?.trim() || undefined,
    getVibRelayChainId: parsed.GET_VIB_RELAY_CHAIN_ID,
    getVibRelayTokenSymbol: parsed.GET_VIB_RELAY_TOKEN_SYMBOL.trim() || undefined,
    getVibRelayTokenDecimals: parsed.GET_VIB_RELAY_TOKEN_DECIMALS,
    getVibDepositScanIntervalMs: parsed.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS,
    getVibDepositStartBlock: parsed.GET_VIB_DEPOSIT_START_BLOCK,
    getVibDepositFinalityBlocks: parsed.GET_VIB_DEPOSIT_FINALITY_BLOCKS,
    getVibCurvePaused: parsed.GET_VIB_CURVE_PAUSED,
    otelExporterOtlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    viblyCoordinationRoundIntervalMs: parsed.VIBLY_COORDINATION_ROUND_INTERVAL_MS,
    observationSubmitRatio: parsed.OBSERVATION_SUBMIT_RATIO,
    globalMaxReviewersPerCycle: parsed.GLOBAL_MAX_REVIEWERS_PER_CYCLE,
    maxReviewCycles: parsed.MAX_REVIEW_CYCLES,
    reviewCycleIntervalMs: parsed.REVIEW_CYCLE_INTERVAL_MS,
    reviewDeadlineMs: parsed.REVIEW_DEADLINE_MS,
    agentReconnectMaxAttempts: parsed.AGENT_RECONNECT_MAX_ATTEMPTS,
    agentReconnectBaseDelayMs: parsed.AGENT_RECONNECT_BASE_DELAY_MS,
    agentReconnectMaxDelayMs: parsed.AGENT_RECONNECT_MAX_DELAY_MS,
    agentConnectionDebounceMs: parsed.AGENT_CONNECTION_DEBOUNCE_MS,
    clientVersionEnforcement: parsed.CLIENT_VERSION_ENFORCEMENT,
    minimumClientVersion: parsed.MINIMUM_CLIENT_VERSION,
    recommendedClientVersion: parsed.RECOMMENDED_CLIENT_VERSION,
    minimumContractVersion: parsed.MINIMUM_CONTRACT_VERSION,
    upgradeDeadline: parsed.UPGRADE_DEADLINE?.trim() || undefined,
    upgradeInstructionsUrl: parsed.UPGRADE_INSTRUCTIONS_URL,
    protocolVersion: parsed.PROTOCOL_VERSION,
    networkManifestJson: manifestInput.raw.trim() || undefined,
    networkManifestFile: parsed.NETWORK_MANIFEST_FILE.trim() || undefined,
    chainAuthorityMode: parsed.CHAIN_AUTHORITY_MODE,
    chainAuthorityRpcUrl: parsed.CHAIN_AUTHORITY_RPC_URL.trim() || parsed.SUBSTRATE_RPC_URL,
    chainAuthorityChainId: parsed.CHAIN_AUTHORITY_CHAIN_ID,
    chainAuthorityCacheTtlMs: parsed.CHAIN_AUTHORITY_CACHE_TTL_MS,
    chainAuthorityMaxStalenessBlocks: parsed.CHAIN_AUTHORITY_MAX_STALENESS_BLOCKS,
    orgAdminAuthoritySource: parsed.ORG_ADMIN_AUTHORITY_SOURCE,
    orgMembershipMinActiveStake: parsed.ORG_MEMBERSHIP_MIN_ACTIVE_STAKE,
  };
}

function readNetworkManifestInput(input: { NETWORK_MANIFEST_FILE?: string; NETWORK_MANIFEST_JSON?: string }): {
  raw: string;
  parsed?: unknown;
  path: "NETWORK_MANIFEST_FILE" | "NETWORK_MANIFEST_JSON";
  error?: string;
} {
  const file = input.NETWORK_MANIFEST_FILE?.trim();
  const inline = input.NETWORK_MANIFEST_JSON?.trim() ?? "";
  const path = file ? "NETWORK_MANIFEST_FILE" : "NETWORK_MANIFEST_JSON";

  let raw = "";
  if (file) {
    try {
      raw = readFileSync(resolve(file), "utf8").trim();
    } catch {
      if (!inline) return { raw: "", path, error: `NETWORK_MANIFEST_FILE does not exist or cannot be read: ${file}` };
    }
  }

  if (!raw && inline) {
    raw = inline;
  }

  if (!raw) return { raw: "", path };

  try {
    return { raw, parsed: JSON.parse(raw), path };
  } catch {
    return { raw, path, error: `${path} must contain valid JSON` };
  }
}

function hasManifestFeature(manifests: unknown, feature: string): boolean {
  if (!Array.isArray(manifests)) return false;
  return manifests.some((manifest) => {
    if (!manifest || typeof manifest !== "object") return false;
    const features = (manifest as Record<string, unknown>).features;
    if (!features || typeof features !== "object") return false;
    return (features as Record<string, unknown>)[feature] === true;
  });
}

function manifestViblyChainOnline(manifests: unknown): boolean {
  if (!Array.isArray(manifests)) return false;
  return manifests.some((manifest) => {
    if (!manifest || typeof manifest !== "object") return false;
    const chains = (manifest as Record<string, unknown>).chains;
    if (!chains || typeof chains !== "object") return false;
    const vibly = (chains as Record<string, unknown>).vibly;
    return Boolean(vibly && typeof vibly === "object" && (vibly as Record<string, unknown>).status === "online");
  });
}
