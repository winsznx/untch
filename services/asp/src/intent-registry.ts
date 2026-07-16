/**
 * SpendIntentRegistry client — register intents above policy.anchorIntentsAbove and
 * setStatus after preflight. Writer-gated; returns honest null when unwired.
 */

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  activeChain,
  activeRpcUrl,
  contractsForChain,
  type ChainEnv,
} from "@untch/shared";
import type { SpendIntent } from "@untch/canon";

const SPEND_INTENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "registerIntent",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "buyerAgentId", type: "uint256" },
          { name: "workerAgentId", type: "uint256" },
          { name: "token", type: "address" },
          { name: "maxAmount", type: "uint256" },
          { name: "taskHash", type: "bytes32" },
          { name: "acceptanceHash", type: "bytes32" },
          { name: "schemaHash", type: "bytes32" },
          { name: "policyHash", type: "bytes32" },
          { name: "deadline", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      },
      { name: "policyId", type: "uint256" },
    ],
    outputs: [{ name: "intentHash", type: "bytes32" }],
  },
  {
    type: "function",
    name: "setStatus",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intentHash", type: "bytes32" },
      { name: "newStatus", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

/** Status enum: NONE=0, PENDING=1, APPROVED=2, BLOCKED=3, SETTLED=4, DISPUTED=5 */
export const IntentStatus = {
  PENDING: 1,
  APPROVED: 2,
  BLOCKED: 3,
  SETTLED: 4,
  DISPUTED: 5,
} as const;

export type OnchainIntentRef = {
  readonly registered: boolean;
  readonly status: "PENDING" | "APPROVED" | "BLOCKED" | "below_anchor_threshold" | "unwired" | "error";
  readonly txHash?: Hex;
  readonly registry?: Address;
  readonly chainId?: number;
  readonly reason?: string;
};

export interface IntentRegistryClient {
  readonly chainId: number;
  readonly registry: Address;
  register(intent: SpendIntent, policyId: bigint): Promise<OnchainIntentRef>;
  setStatus(intentHash: Hex, status: number): Promise<OnchainIntentRef>;
}

export function initIntentRegistry(env: ChainEnv = process.env): IntentRegistryClient | null {
  const pk = env.INTENT_WRITER_PRIVATE_KEY?.trim() || env.RECEIPT_WRITER_PRIVATE_KEY?.trim();
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;

  const chain = activeChain(env);
  const contracts = contractsForChain(chain.id);
  const registry = getAddress(
    env.SPEND_INTENT_REGISTRY?.trim() || contracts.spendIntentRegistry,
  ) as Address;
  const account = privateKeyToAccount(pk as Hex);
  const transport = http(activeRpcUrl(env));
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const walletClient: WalletClient = createWalletClient({ chain, transport, account });

  return {
    chainId: chain.id,
    registry,
    async register(intent, policyId) {
      try {
        const hash = await walletClient.writeContract({
          address: registry,
          abi: SPEND_INTENT_REGISTRY_ABI,
          functionName: "registerIntent",
          args: [intent, policyId],
          account,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        return {
          registered: true,
          status: "PENDING",
          txHash: hash,
          registry,
          chainId: chain.id,
        };
      } catch (err) {
        return {
          registered: false,
          status: "error",
          registry,
          chainId: chain.id,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async setStatus(intentHash, status) {
      try {
        const hash = await walletClient.writeContract({
          address: registry,
          abi: SPEND_INTENT_REGISTRY_ABI,
          functionName: "setStatus",
          args: [intentHash, status],
          account,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        const name =
          status === IntentStatus.APPROVED
            ? "APPROVED"
            : status === IntentStatus.BLOCKED
              ? "BLOCKED"
              : "PENDING";
        return {
          registered: true,
          status: name,
          txHash: hash,
          registry,
          chainId: chain.id,
        };
      } catch (err) {
        return {
          registered: true,
          status: "error",
          registry,
          chainId: chain.id,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/** Whether display amount meets policy.anchorIntentsAbove (or always if threshold is 0). */
export function shouldAnchorIntent(
  amount: number,
  rules: { readonly anchorIntentsAbove?: number },
): boolean {
  if (typeof rules.anchorIntentsAbove !== "number") return false;
  return amount >= rules.anchorIntentsAbove;
}
