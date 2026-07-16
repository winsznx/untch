import { createPublicClient, http, type PublicClient } from "viem";
import { productChain } from "../chain/chains";

/**
 * Read-only chain access for dashboard server/client reads. Targets the product chain
 * (NEXT_PUBLIC_CHAIN_ID, default mainnet).
 */
export function makePublicClient(): PublicClient {
  const chain = productChain();
  return createPublicClient({ chain, transport: http() });
}
