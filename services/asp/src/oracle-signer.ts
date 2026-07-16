/**
 * Mode C oracle signer — optional. Signs UntchVault.spend EIP-712 when
 * ORACLE_PRIVATE_KEY is set and preflight returns APPROVED with vaultAddress.
 * One env key per process (demo / single-vault operators). Multi-tenant map is V1.5.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain, activeRpcUrl, type ChainEnv } from "@untch/shared";

const VAULT_SPEND_ABI = [
  {
    type: "function",
    name: "spendDigest",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "intentHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export type SpendSig = {
  readonly sig: Hex;
  readonly nonce: bigint;
  readonly expiry: bigint;
  readonly digest: Hex;
  readonly vault: Address;
};

export interface OracleSigner {
  signSpend(input: {
    vault: Address;
    recipient: Address;
    amount: bigint;
    token: Address;
    intentHash: Hex;
    /** Max 10 minutes from now per vault comments / PRD §16. */
    expirySecs?: number;
  }): Promise<SpendSig>;
}

export function initOracleSigner(env: ChainEnv = process.env): OracleSigner | null {
  const pk = env.ORACLE_PRIVATE_KEY?.trim();
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;

  const chain = activeChain(env);
  const account = privateKeyToAccount(pk as Hex);
  const transport = http(activeRpcUrl(env));
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });

  return {
    async signSpend(input) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      const nonce = BigInt(
        `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      );
      const ttl = Math.min(input.expirySecs ?? 600, 600);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + ttl);

      const digest = (await publicClient.readContract({
        address: input.vault,
        abi: VAULT_SPEND_ABI,
        functionName: "spendDigest",
        args: [input.recipient, input.amount, input.token, input.intentHash, nonce, expiry],
      })) as Hex;

      // EIP-712 domain name="UntchVault" matching UntchVault.sol
      const sig = await walletClient.signTypedData({
        account,
        domain: {
          name: "UntchVault",
          chainId: chain.id,
          verifyingContract: input.vault,
        },
        types: {
          Spend: [
            { name: "recipient", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "token", type: "address" },
            { name: "intentHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
            { name: "expiry", type: "uint256" },
          ],
        },
        primaryType: "Spend",
        message: {
          recipient: input.recipient,
          amount: input.amount,
          token: input.token,
          intentHash: input.intentHash,
          nonce,
          expiry,
        },
      });

      return { sig, nonce, expiry, digest, vault: input.vault };
    },
  };
}
