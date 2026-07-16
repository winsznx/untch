import { resolveChainId, X_LAYER_MAINNET_ID } from "@untch/shared";

/**
 * The single chain a connected wallet MUST be on before it can sign in or write — the product chain,
 * selected by NEXT_PUBLIC_CHAIN_ID (inlined at build; unset ⇒ X Layer mainnet 196). Testnet builds
 * set NEXT_PUBLIC_CHAIN_ID=1952. Normalising every connected wallet to this chain before SIWE closes
 * the RainbowKit silent-fail path on unconfigured chains.
 */
export const REQUIRED_CHAIN_ID: number = resolveChainId(
  { CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID },
  X_LAYER_MAINNET_ID,
);

export type NetworkAction =
  | { readonly kind: "ready" }
  | { readonly kind: "switch"; readonly targetChainId: number };

/**
 * Decide whether a connected wallet needs an explicit chain switch before SIWE / any write.
 *
 * `chainId` MUST be wagmi's `useAccount().chainId` — the wallet's ACTUAL current chain as a raw number,
 * which stays defined even when the wallet is on a chain outside the app's configured set. (That is the key
 * difference from `useAccount().chain?.id`, which goes `undefined` for unconfigured chains and is exactly
 * the value RainbowKit's sign step bails on.) Pure and React-free so the branch logic is unit-testable.
 */
export function resolveNetworkAction(input: {
  readonly isConnected: boolean;
  readonly chainId: number | undefined;
}): NetworkAction {
  if (!input.isConnected || input.chainId === undefined) return { kind: "ready" };
  if (input.chainId === REQUIRED_CHAIN_ID) return { kind: "ready" };
  return { kind: "switch", targetChainId: REQUIRED_CHAIN_ID };
}
