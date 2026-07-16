/**
 * Startup integrity check against the live X Layer Identity registry.
 * Fails loud if name/symbol drift (Draft EIP / proxy upgrade risk).
 */

import { createPublicClient, http, type Address } from "viem";
import { xLayerMainnet } from "@untch/shared";
import {
  ERC8004_IDENTITY_MAINNET,
  EXPECTED_IDENTITY_NAME,
  EXPECTED_IDENTITY_SYMBOL,
  IDENTITY_REGISTRY_ABI,
} from "./constants";

export type IdentityAssertResult =
  | { ok: true; name: string; symbol: string; address: Address }
  | { ok: false; error: string };

export async function assertIdentityRegistry(
  rpcUrl = process.env.RPC_URL?.trim() || "https://rpc.xlayer.tech",
): Promise<IdentityAssertResult> {
  try {
    const client = createPublicClient({
      chain: xLayerMainnet,
      transport: http(rpcUrl),
    });
    const address = ERC8004_IDENTITY_MAINNET as Address;
    const [name, symbol] = await Promise.all([
      client.readContract({
        address,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "name",
      }),
      client.readContract({
        address,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "symbol",
      }),
    ]);
    if (name !== EXPECTED_IDENTITY_NAME || symbol !== EXPECTED_IDENTITY_SYMBOL) {
      return {
        ok: false,
        error: `Identity registry mismatch: name=${name} symbol=${symbol} (expected ${EXPECTED_IDENTITY_NAME}/${EXPECTED_IDENTITY_SYMBOL})`,
      };
    }
    return { ok: true, name, symbol, address };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
