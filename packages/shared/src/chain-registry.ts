import {
  CONTRACTS_BY_CHAIN,
  DEFAULT_CHAIN_ID,
  SETTLEMENT_TOKEN_KEY,
  TOKENS,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_DEPRECATED_ID,
  X_LAYER_TESTNET_ID,
  chainById,
  isConfirmed,
  type DeployedContracts,
} from "./chains";
import type { Address } from "viem";

/**
 * One registry, derived, that every production route and manifest answers "which chain" from.
 *
 * WHY THIS EXISTS
 *
 * `chains.ts` already held the verified constants, and it was still possible for four separate
 * production surfaces to disagree about which X Layer testnet exists. Sign-in accepted 195 — the
 * DEPRECATED original testnet, which has no live RPC — and rejected 1952, the one that answers.
 * The consumer flag layer mapped `CONSUMER_XLAYER_TESTNET_ENABLED` onto 195, so enabling the
 * testnet rail enabled a chain nothing can reach. The policy store defaulted its registry address
 * to testnet on a service that only ever ships on mainnet. Each of those was a locally-retyped
 * constant, and each was individually defensible; together they meant the deployment could not
 * state, from one place, what it believed about a chain.
 *
 * The constants were never the problem. What was missing was a place where the DERIVED facts live:
 * whether a chain may be signed in on, whether it is deprecated, whether it is safe for a
 * production surface to name. Those are policy, not configuration, and policy that is re-decided
 * per call site is policy that drifts.
 *
 * WHY IT IS DERIVED RATHER THAN AUTHORED
 *
 * Every field here is computed from `chains.ts` — the D0.3-verified source with its per-constant
 * provenance table. Authoring a second table would create exactly the divergence this closes: two
 * lists of chains, both plausible, differing in one row that nobody reads. `pnpm gen:chains` writes
 * the JSON projection consumed by manifests and non-TypeScript callers, and CI fails when that
 * projection drifts from this module.
 *
 * WHAT DEPRECATED MEANS HERE
 *
 * A deprecated chain is not deleted. Deleting 195 would make an old signature that names it fail
 * with "unsupported chain", which is indistinguishable from a typo. It is listed, marked, and
 * refused by name, so a caller who signed for 195 is told the chain was retired rather than that
 * their request was malformed.
 */

/** `active-mainnet` settles real value. `active-testnet` answers RPC. `deprecated` does neither. */
export type ChainStatus = "active-mainnet" | "active-testnet" | "deprecated";

export interface RegistrySettlementToken {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
}

export interface ChainRegistryEntry {
  readonly chainId: number;
  readonly caip2: string;
  readonly name: string;
  readonly status: ChainStatus;
  readonly testnet: boolean;
  /** True only for `deprecated`. Kept as its own field so a check reads as a question, not a string compare. */
  readonly deprecated: boolean;
  readonly rpcUrls: readonly string[];
  readonly explorerUrl: string | null;
  /** The four base Untch contracts, or null where none are deployed. */
  readonly contracts: DeployedContracts | null;
  /** The x402 settlement stablecoin, or null where no confirmed one exists. */
  readonly settlementToken: RegistrySettlementToken | null;
  /**
   * May a SIWE message name this chain?
   *
   * Sign-in proves control of a key, and a key is the same key on every chain, so this is not about
   * where value moves. It is about not accepting a chain the deployment cannot itself reach: a
   * signature naming a retired chain cannot be checked against anything live.
   */
  readonly signIn: boolean;
  /**
   * May a PUBLIC production surface — a manifest, a catalog, a 402 challenge, an error body — name
   * this chain? Only chains this build actually ships on. The scanner enforces it.
   */
  readonly productionVisible: boolean;
  /** The human-typed consumer flag alias, or null where none is documented. */
  readonly flagAlias: string | null;
}

function statusOf(chainId: number): ChainStatus {
  if (chainId === X_LAYER_TESTNET_DEPRECATED_ID) return "deprecated";
  return chainById(chainId).testnet ? "active-testnet" : "active-mainnet";
}

function settlementTokenOf(chainId: number): RegistrySettlementToken | null {
  const key = SETTLEMENT_TOKEN_KEY[chainId];
  const set = TOKENS[chainId as keyof typeof TOKENS] as Record<string, unknown> | undefined;
  const entry = key && set ? set[key] : undefined;
  if (!entry || typeof entry !== "object") return null;
  const token = entry as Parameters<typeof isConfirmed>[0];
  if (!isConfirmed(token)) return null;
  return { symbol: token.symbol, address: token.address, decimals: token.decimals };
}

function entryFor(chainId: number, flagAlias: string | null): ChainRegistryEntry {
  const chain = chainById(chainId);
  const status = statusOf(chainId);
  return {
    chainId,
    caip2: `eip155:${chainId}`,
    name: chain.name,
    status,
    testnet: chain.testnet === true,
    deprecated: status === "deprecated",
    rpcUrls: [...chain.rpcUrls.default.http],
    explorerUrl: chain.blockExplorers?.default.url ?? null,
    contracts: CONTRACTS_BY_CHAIN[chainId] ?? null,
    settlementToken: settlementTokenOf(chainId),
    signIn: status !== "deprecated",
    productionVisible: status === "active-mainnet",
    flagAlias,
  };
}

/**
 * The deprecated original X Layer testnet, listed so it can be REFUSED BY NAME.
 *
 * It is not in `CHAINS`, so `chainById` throws for it — deliberately, because nothing may resolve a
 * client against it. It is described here anyway so a caller who signs for 195 gets "this chain was
 * retired; the active testnet is 1952" instead of an unsupported-chain error that reads like a typo.
 */
const DEPRECATED_X_LAYER_TESTNET: ChainRegistryEntry = {
  chainId: X_LAYER_TESTNET_DEPRECATED_ID,
  caip2: `eip155:${X_LAYER_TESTNET_DEPRECATED_ID}`,
  name: "X Layer Testnet (deprecated)",
  status: "deprecated",
  testnet: true,
  deprecated: true,
  rpcUrls: [],
  explorerUrl: null,
  contracts: null,
  settlementToken: null,
  signIn: false,
  productionVisible: false,
  flagAlias: null,
};

/** Every chain this codebase knows about, including the retired one. Order is stable for the generator. */
export const CHAIN_REGISTRY: readonly ChainRegistryEntry[] = [
  entryFor(X_LAYER_MAINNET_ID, "CONSUMER_XLAYER_ENABLED"),
  entryFor(X_LAYER_TESTNET_ID, "CONSUMER_XLAYER_TESTNET_ENABLED"),
  DEPRECATED_X_LAYER_TESTNET,
];

export function chainRegistryEntry(chainId: number): ChainRegistryEntry | undefined {
  return CHAIN_REGISTRY.find((e) => e.chainId === chainId);
}

/** The chain ids a SIWE message may name. Deprecated chains are excluded by construction. */
export const SIGNIN_CHAIN_IDS: readonly number[] = CHAIN_REGISTRY.filter((e) => e.signIn).map(
  (e) => e.chainId,
);

/** The chain ids a public production surface may name. */
export const PRODUCTION_VISIBLE_CHAIN_IDS: readonly number[] = CHAIN_REGISTRY.filter(
  (e) => e.productionVisible,
).map((e) => e.chainId);

export const DEPRECATED_CHAIN_IDS: readonly number[] = CHAIN_REGISTRY.filter(
  (e) => e.deprecated,
).map((e) => e.chainId);

export function isDeprecatedChain(chainId: number): boolean {
  return DEPRECATED_CHAIN_IDS.includes(chainId);
}

/** CAIP-2 → consumer flag alias, derived so the flag layer cannot name a chain the registry does not. */
export const CHAIN_FLAG_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  CHAIN_REGISTRY.filter((e) => e.flagAlias !== null).map((e) => [e.caip2, e.flagAlias as string]),
);

/**
 * The reason a chain was refused, phrased for the caller rather than for the log.
 *
 * Returns null when the chain is acceptable. A deprecated chain names its replacement, because the
 * useful thing to tell someone holding a 195 signature is which id to sign for instead.
 */
export function signInRefusal(chainId: number): string | null {
  const entry = chainRegistryEntry(chainId);
  if (entry?.signIn === true) return null;
  const allowed = SIGNIN_CHAIN_IDS.join(", ");
  if (entry?.deprecated === true) {
    return `chain ${chainId} is the retired X Layer testnet and has no live RPC; sign in on ${allowed}`;
  }
  return `chain ${chainId} is not a supported sign-in chain; sign in on ${allowed}`;
}

/** The default chain id, re-exported so a caller needs one import rather than two. */
export { DEFAULT_CHAIN_ID };
