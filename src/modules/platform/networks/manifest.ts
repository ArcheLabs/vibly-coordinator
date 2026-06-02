import { z } from "zod";
import type { CoordinatorConfig } from "../../../config/env.js";
import { getVersionPolicy } from "../version-policy/policy.js";

const FeatureFlagsSchema = z.object({
  agentJoin: z.boolean(),
  daemon: z.boolean(),
  staking: z.boolean(),
  rootIdentityRegistration: z.boolean(),
  getVibConversion: z.boolean(),
  getVibClaim: z.boolean(),
});

const ChainManifestSchema = z.object({
  chainId: z.string().min(1),
  genesisHash: z.string().optional(),
  rpcUrls: z.array(z.string().url()).default([]),
  tokenSymbol: z.string().optional(),
  tokenDecimals: z.number().int().nonnegative().optional(),
  explorerTxUrl: z.string().url().optional(),
  status: z.enum(["online", "prelaunch", "maintenance", "offline"]).optional(),
});

export const NetworkManifestSchema = z.object({
  manifestVersion: z.literal(1).default(1),
  updatedAt: z.string().datetime(),
  ttlSeconds: z.number().int().positive().default(600),
  id: z.string().min(1),
  label: z.string().min(1),
  stage: z.enum(["local", "testnet", "mainnet"]),
  status: z.enum(["active", "prelaunch", "maintenance", "deprecated"]),
  coordinatorUrls: z.array(z.string().url()).min(1),
  chains: z.object({
    payment: ChainManifestSchema,
    vibly: ChainManifestSchema,
  }),
  features: FeatureFlagsSchema,
  messages: z.record(z.string()).optional(),
});

export type NetworkManifest = z.infer<typeof NetworkManifestSchema> & {
  minimumClientVersion?: string;
  recommendedClientVersion?: string;
};

const NetworkManifestListSchema = z.array(NetworkManifestSchema);

export function getNetworkManifests(config: CoordinatorConfig): NetworkManifest[] {
  const parsed = parseConfiguredManifests(config);
  const base = parsed.length ? parsed : defaultNetworkManifests(config);
  const policy = getVersionPolicy(config);
  return base.map((manifest) => ({
    ...redactManifest(manifest),
    minimumClientVersion: policy.minimumClientVersion,
    recommendedClientVersion: policy.recommendedClientVersion,
  }));
}

export function getNetworkManifest(config: CoordinatorConfig, networkId: string): NetworkManifest | undefined {
  return getNetworkManifests(config).find((manifest) => manifest.id === networkId);
}

export function parseConfiguredManifests(config: CoordinatorConfig): NetworkManifest[] {
  if (!config.networkManifestJson?.trim()) return [];
  const parsed = JSON.parse(config.networkManifestJson) as unknown;
  const manifests = NetworkManifestListSchema.parse(parsed);
  if (config.nodeEnv === "production") validateProductionManifests(manifests);
  return manifests;
}

function defaultNetworkManifests(config: CoordinatorConfig): NetworkManifest[] {
  const now = new Date().toISOString();
  const coordinatorUrl = `http://localhost:${config.port}`;
  const polkadotRpcUrls = [
    "wss://rpc.polkadot.io",
    "wss://polkadot.api.onfinality.io/public-ws",
    "wss://polkadot-rpc.dwellir.com",
  ];
  return [
    {
      manifestVersion: 1,
      updatedAt: now,
      ttlSeconds: 600,
      id: config.substrateChainId,
      label: config.nodeEnv === "production" ? "Vibly Network" : "Local",
      stage: config.nodeEnv === "production" ? "mainnet" : "local",
      status: "active",
      coordinatorUrls: [coordinatorUrl],
      chains: {
        payment: {
          chainId: config.getVibRelayChainId,
          rpcUrls: config.getVibRelayRpcUrl ? [config.getVibRelayRpcUrl] : [],
          tokenSymbol: config.getVibRelayTokenSymbol ?? "DOT",
          tokenDecimals: config.getVibRelayTokenDecimals,
          status: config.getVibRelayRpcUrl ? "online" : "maintenance",
        },
        vibly: {
          chainId: config.substrateChainId,
          rpcUrls: [config.substrateRpcUrl],
          status: "online",
        },
      },
      features: {
        agentJoin: true,
        daemon: true,
        staking: true,
        rootIdentityRegistration: true,
        getVibConversion: !config.getVibCurvePaused,
        getVibClaim: true,
      },
    },
    {
      manifestVersion: 1,
      updatedAt: now,
      ttlSeconds: 600,
      id: "substrate:vibly-incentivized-testnet",
      label: "Incentivized Testnet",
      stage: "testnet",
      status: "prelaunch",
      coordinatorUrls: [coordinatorUrl],
      chains: {
        payment: {
          chainId: "polkadot",
          rpcUrls: polkadotRpcUrls,
          tokenSymbol: "DOT",
          tokenDecimals: 10,
          status: "online",
        },
        vibly: {
          chainId: "substrate:vibly-incentivized-testnet",
          rpcUrls: [],
          status: "prelaunch",
        },
      },
      features: {
        agentJoin: false,
        daemon: false,
        staking: false,
        rootIdentityRegistration: false,
        getVibConversion: true,
        getVibClaim: false,
      },
      messages: {
        getVibClaim: "VIB claim to incentivized testnet is not live yet.",
        prelaunch: "Incentivized testnet agent onboarding will open after the network launch.",
      },
    },
  ].map((manifest) => NetworkManifestSchema.parse(manifest));
}

function validateProductionManifests(manifests: NetworkManifest[]) {
  for (const manifest of manifests) {
    if (!manifest.coordinatorUrls.length) throw new Error(`NETWORK_MANIFEST_JSON ${manifest.id} requires coordinatorUrls`);
    if (!manifest.features) throw new Error(`NETWORK_MANIFEST_JSON ${manifest.id} requires features`);
    for (const [name, chain] of Object.entries(manifest.chains)) {
      if (chain.status === "online" && !chain.genesisHash) {
        throw new Error(`NETWORK_MANIFEST_JSON ${manifest.id} ${name} chain requires genesisHash when online`);
      }
    }
  }
}

function redactManifest(manifest: NetworkManifest): NetworkManifest {
  return NetworkManifestSchema.parse(JSON.parse(JSON.stringify(manifest))) as NetworkManifest;
}
