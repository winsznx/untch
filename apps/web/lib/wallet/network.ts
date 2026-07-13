import { X_LAYER_TESTNET_ID } from "../chain/chains";

/**
 * The single chain a connected wallet MUST be on before it can sign in or write — the product chain
 * (X Layer testnet). Sign-in identity is chain-agnostic in principle, but making the wallet deterministic
 * here removes an entire failure class: RainbowKit's SIWE step reads `useAccount().chain` (the viem chain
 * OBJECT), which wagmi resolves to `undefined` for any chain outside the configured set — and its sign
 * handler then silently returns without building a message or prompting a signature. A wallet parked on
 * Ethereum mainnet (or anything else) therefore fails sign-in with no error at all. Normalising every
 * connected wallet to this chain before the sign step is what closes that hole for ALL connectors, instead
 * of relying on individual wallets (MetaMask) happening to auto-switch on connect while others (OKX) don't.
 */
export const REQUIRED_CHAIN_ID: number = X_LAYER_TESTNET_ID;

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
