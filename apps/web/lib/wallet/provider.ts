import { createPublicClient, http, type PublicClient } from "viem";
import { xLayerTestnet } from "../chain/chains";

/**
 * Read-only chain access for the dashboard's server/client reads (predicted policy id, token decimals,
 * allowance, computed vault address, tx receipts). Connect / chain-switch / signing all live in wagmi +
 * RainbowKit now (see components/wallet/*), so this module is just the public client over the X Layer
 * testnet RPC.
 */
export function makePublicClient(): PublicClient {
  return createPublicClient({ chain: xLayerTestnet, transport: http() });
}
