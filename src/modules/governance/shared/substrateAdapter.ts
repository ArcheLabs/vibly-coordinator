import type { FastifyInstance } from "fastify";

export async function createSubstrateGovernanceActionsAdapter(fastify: FastifyInstance) {
  const { SubstrateGovernanceActionsAdapter } = await import("@vibly-ai/concord-adapter-substrate-actions");
  const config: ConstructorParameters<typeof SubstrateGovernanceActionsAdapter>[0] = {
    rpcUrl: fastify.config.substrateRpcUrl,
    chainId: fastify.config.substrateChainId,
  };
  if (fastify.config.substrateGovernanceTxMode === "fixture") {
    config.submitter = async (input) => ({
      txHash: `0xphasee_${input.call}_${Date.now().toString(16)}`,
      chain: input.chain,
      finality: "included" as const,
    });
  }
  return new SubstrateGovernanceActionsAdapter(config);
}
