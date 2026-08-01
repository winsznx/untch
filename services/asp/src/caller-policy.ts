import { activeChain, activeRpcUrl } from "@untch/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Client-side helper for the CHANGED `create_spend_policy` flow (Part 1). The seller no longer signs, so a
 * caller must drive the two steps itself:
 *   1. POST /create_spend_policy → get the UNSIGNED registerPolicy calldata.
 *   2. sign + submit it with the CALLER's own wallet (the caller becomes the on-chain owner).
 *   3. POST /sync_policy_registration { txHash, rules } → the seller records the row from the confirmed
 *      event and returns the policyId + real owner.
 *
 * This is what the live escalation proofs use to obtain an escalate-friendly policy the caller genuinely
 * owns. Submitting registerPolicy needs testnet OKB in the caller wallet — an honest prerequisite, surfaced
 * as a clear error, never a fabricated success.
 */

export interface CallerCreatedPolicy {
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly registerTx: Hex;
  readonly owner: Address;
}

interface BuildResponse {
  unsignedTx?: { to?: string; calldata?: string };
  policyHash?: string;
  code?: string;
  message?: string;
}

interface SyncResponse {
  policyId?: string;
  owner?: string;
  policyHash?: string;
  tx?: string;
  code?: string;
  message?: string;
}

/**
 * Create a policy the CALLER owns, through the live seller endpoints. Throws with a precise message on any
 * failure (seller not configured to build, unfunded caller wallet, reverted tx, sync rejected).
 */
export async function createPolicyViaEndpoint(args: {
  readonly sellerUrl: string;
  readonly callerKey: Hex;
  readonly agent: Address;
  readonly rules: Record<string, unknown>;
  readonly rpcUrl?: string;
}): Promise<CallerCreatedPolicy> {
  /**
   * The chain comes from the SAME env contract the seller resolves its own chain from.
   *
   * It was pinned to X Layer testnet. This is the helper a caller uses to obtain the policy id the two
   * marketplace-listed services demand, so a testnet default meant the documented path to a usable
   * policy quietly created one on a network production has never read. An explicit `rpcUrl` still
   * wins; what changed is that the fallback follows CHAIN_ID/NETWORK instead of a retyped constant.
   */
  const chain = activeChain(process.env);
  const rpcUrl = args.rpcUrl ?? activeRpcUrl(process.env);
  const account = privateKeyToAccount(args.callerKey);

  // 1) ask the seller to BUILD the unsigned registerPolicy call.
  const buildRes = await fetch(`${args.sellerUrl}/create_spend_policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: args.agent, rules: args.rules }),
  });
  const build = (await buildRes.json()) as BuildResponse;
  const to = build.unsignedTx?.to;
  const calldata = build.unsignedTx?.calldata;
  if (!buildRes.ok || !to || !calldata || !build.policyHash) {
    throw new Error(
      `create_spend_policy (build) failed (${buildRes.status}): ${build.code ?? ""} ${build.message ?? JSON.stringify(build)}`,
    );
  }

  // 2) the CALLER's own wallet signs + submits the built calldata (caller becomes the on-chain owner).
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const balance = await pub.getBalance({ address: account.address });
  if (balance === 0n) {
    throw new Error(
      `caller ${account.address} has 0 OKB on ${chain.name} (chain ${chain.id}) — fund it to submit registerPolicy (the seller no longer signs on your behalf)`,
    );
  }
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const registerTx = await wallet.sendTransaction({
    account,
    chain,
    to: to as Address,
    data: calldata as Hex,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash: registerTx });
  if (rcpt.status !== "success") throw new Error(`registerPolicy reverted (tx ${registerTx})`);

  // 3) the seller SYNCS the row from the confirmed event (owner read on-chain, not assumed).
  const syncRes = await fetch(`${args.sellerUrl}/sync_policy_registration`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash: registerTx, rules: args.rules }),
  });
  const sync = (await syncRes.json()) as SyncResponse;
  if (!syncRes.ok || !sync.policyId || !sync.owner) {
    throw new Error(
      `sync_policy_registration failed (${syncRes.status}): ${sync.code ?? ""} ${sync.message ?? JSON.stringify(sync)}`,
    );
  }

  return {
    policyId: sync.policyId,
    policyHash: (sync.policyHash ?? build.policyHash).toLowerCase() as Hex,
    registerTx,
    owner: sync.owner as Address,
  };
}
