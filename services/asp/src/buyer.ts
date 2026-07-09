import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@okxweb3/x402-fetch";
import { x402Client } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { CHAIN, NETWORK, SETTLEMENT_TOKEN } from "./config";

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** A fetch that records the outbound x402 payment header the wrapper attaches on retry. */
export type RecordingFetch = {
  fetch: typeof globalThis.fetch;
  getPaymentSignature: () => string | undefined;
};

export function makeRecordingFetch(): RecordingFetch {
  let captured: string | undefined;
  const recording: typeof globalThis.fetch = (input, init) => {
    // `wrapFetchWithPayment` retries by calling `fetch(clonedRequest)` — a Request object with NO
    // `init` — so the signature lives on the Request's own headers, not on `init.headers`. Read
    // both so the paid retry's PAYMENT-SIGNATURE is actually captured (D0.1 missed it this way).
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
    if (sig) captured = sig;
    return fetch(input, init);
  };
  return { fetch: recording, getPaymentSignature: () => captured };
}

/**
 * Build the buyer's payment-aware fetch. The buyer signs EIP-3009 authorizations with its own
 * key (self-custody) — the wrapper handles the 402 challenge → sign → retry loop.
 */
export function makeBuyerFetch(
  buyerPrivateKey: `0x${string}`,
  recording: RecordingFetch,
): ReturnType<typeof wrapFetchWithPayment> {
  const account = privateKeyToAccount(buyerPrivateKey);
  const publicClient = createPublicClient({ chain: CHAIN, transport: http() });

  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer));

  return wrapFetchWithPayment(recording.fetch, client);
}

export function buyerAddress(buyerPrivateKey: `0x${string}`): `0x${string}` {
  return privateKeyToAccount(buyerPrivateKey).address;
}

/** Read the buyer's USDT0 balance (atomic units) on X Layer via the reachable public RPC. */
export async function readSettlementBalance(address: `0x${string}`): Promise<bigint> {
  const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
  return publicClient.readContract({
    address: SETTLEMENT_TOKEN.address,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}
