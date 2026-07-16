import { defineChain, type Address, type Chain } from "viem";

/**
 * X Layer network constants (D0.3, §29 / Q5). Every value here was verified from an
 * official source on 2026-07-09 — see internal/day0/D0.3-sources.md for the URL and
 * verification method behind each constant. Do not edit an address or chainId without
 * updating that sources table.
 */

export const X_LAYER_MAINNET_ID = 196 as const;
export const X_LAYER_TESTNET_ID = 1952 as const;

/**
 * chainId 195 (0xc3) is the DEPRECATED original X Layer testnet — no live RPC, marked
 * "deprecated" in the canonical EVM chain registry. The active testnet is 1952 (0x7a0),
 * confirmed by live eth_chainId on testrpc.xlayer.tech. viem's bundled X Layer testnet
 * chain may still point at 195, which is why these objects are defined here from
 * D0.3-verified values rather than imported from viem/chains.
 */
export const X_LAYER_TESTNET_DEPRECATED_ID = 195 as const;

export const xLayerMainnet: Chain = defineChain({
  id: X_LAYER_MAINNET_ID,
  name: "X Layer Mainnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/x-layer" },
  },
  testnet: false,
});

export const xLayerTestnet: Chain = defineChain({
  id: X_LAYER_TESTNET_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testrpc.xlayer.tech", "https://xlayertestrpc.okx.com"] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/x-layer-testnet" },
  },
  testnet: true,
});

export const CHAINS = {
  [X_LAYER_MAINNET_ID]: xLayerMainnet,
  [X_LAYER_TESTNET_ID]: xLayerTestnet,
} as const;

/** Official testnet OKB (gas) faucet — the funding source the D0.3 gate checks against. */
export const X_LAYER_TESTNET_FAUCET_URL = "https://www.okx.com/xlayer/faucet";

export type ConfirmedToken = {
  symbol: string;
  address: Address;
  decimals: number;
  /** Official source(s) the address + decimals were verified from, with date. */
  confirmedFrom: string;
};

export type UnconfirmedToken = {
  symbol: string;
  address: null;
  decimals: null;
  /** Why this token could not be confirmed from an official source. */
  reason: string;
};

export type TokenEntry = ConfirmedToken | UnconfirmedToken;

export const isConfirmed = (t: TokenEntry): t is ConfirmedToken => t.address !== null;

/**
 * Per-network token registry. Confirmed entries carry a checksummed address + decimals
 * read on-chain; unconfirmed entries carry address: null + a reason and are excluded
 * from every allowlist by construction (see confirmedTokenAllowlist).
 */
export const TOKENS = {
  [X_LAYER_MAINNET_ID]: {
    USDT: {
      symbol: "USDT",
      address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d" as Address,
      decimals: 6,
      confirmedFrom:
        "OKLink explorer labels this 'Tether USD' (USDT); on-chain symbol()=USDT, name()='Tether USD', decimals()=6 via rpc.xlayer.tech (2026-07-09). Legacy bridged/wrapped USDT — OKX is phasing it out toward USDT0.",
    },
    USDT0: {
      symbol: "USD₮",
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address,
      decimals: 6,
      confirmedFrom:
        "On-chain symbol()='USD₮', decimals()=6 via rpc.xlayer.tech; OKX Learn 'Tether's USDT0 on X Layer' names this the forward USDT (2026-07-09).",
    },
    USDG: {
      symbol: "USDG",
      address: "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8" as Address,
      decimals: 6,
      confirmedFrom:
        "Issuer globaldollar.com/build-with-usdg lists this exact X Layer address; OKLink explorer labels it 'Global Dollar' (USDG); on-chain symbol()=USDG, name()='Global Dollar', decimals()=6 via rpc.xlayer.tech (2026-07-09).",
    },
  },
  [X_LAYER_TESTNET_ID]: {
    USDT: {
      symbol: "USDT",
      address: null,
      decimals: null,
      reason:
        "UNCONFIRMED: no official X Layer testnet (1952) USDT address found. The testnet faucet issues native OKB only; OKX testnet bridged-token docs on web3.okx.com are unreachable from this environment (HTTP 000). Not guessed.",
    },
    USDG: {
      symbol: "USDG",
      address: null,
      decimals: null,
      reason:
        "UNCONFIRMED: Global Dollar publishes USDG only on mainnets (Ethereum, Ink, Solana, Robinhood Chain, X Layer mainnet); no X Layer testnet deployment is documented. Not guessed.",
    },
  },
} satisfies Record<number, Record<string, TokenEntry>>;

/** Confirmed token addresses only — UNCONFIRMED entries are never included. */
export function confirmedTokenAllowlist(chainId: number): Address[] {
  const set = TOKENS[chainId as keyof typeof TOKENS] as
    | Record<string, TokenEntry>
    | undefined;
  if (!set) return [];
  return Object.values(set)
    .filter(isConfirmed)
    .map((t) => t.address);
}

/**
 * The default x402 settlement token per network — the EIP-3009 stablecoin the seller prices in.
 * X Layer mainnet settles in USDT0 (OKX x402's documented default); X Layer testnet has NO confirmed
 * settleable stablecoin (see TOKENS[1952]), so requesting one there fails loudly rather than guessing.
 */
export const SETTLEMENT_TOKEN_KEY: Partial<Record<number, string>> = {
  [X_LAYER_MAINNET_ID]: "USDT0",
};

export function settlementToken(chainId: number): ConfirmedToken {
  const key = SETTLEMENT_TOKEN_KEY[chainId];
  const set = TOKENS[chainId as keyof typeof TOKENS] as
    | Record<string, TokenEntry>
    | undefined;
  const entry = key && set ? set[key] : undefined;
  if (!entry || !isConfirmed(entry)) {
    throw new Error(
      `No confirmed settlement token for chainId ${chainId} — supported: ${Object.keys(
        SETTLEMENT_TOKEN_KEY,
      ).join(", ")} (X Layer testnet has no confirmed stablecoin; see chains.ts TOKENS).`,
    );
  }
  return entry;
}

/**
 * The four base Untch contracts (§10.1–10.4) deployed per network — the single source every service,
 * library, and the dashboard resolves deployed addresses through. Testnet is the long-standing build;
 * mainnet (X Layer 196) was deployed 2026-07-16 (deployments/mainnet-suite.json), Phase 1 of the
 * two-phase suite. Per-vault instances (UntchVault) are NOT here — they are deployed per operator via
 * the factory. An unknown chain resolves to nothing and fails loudly rather than pointing at a stale net.
 */
export interface DeployedContracts {
  readonly policyRegistry: Address;
  readonly spendIntentRegistry: Address;
  readonly receipts: Address;
  readonly vaultFactory: Address;
}

export const CONTRACTS_BY_CHAIN: Partial<Record<number, DeployedContracts>> = {
  [X_LAYER_TESTNET_ID]: {
    policyRegistry: "0xe1d74c90801db0fa806c72eb818b7671b8233532",
    spendIntentRegistry: "0xf87e50f83172c2dace7d274e4c701212caeb1372",
    receipts: "0x0c64997277b7d94d2999dea22a123cac56334863",
    vaultFactory: "0x1562c6eb1813016c8562cf6771cbf715007bb7e9",
  },
  [X_LAYER_MAINNET_ID]: {
    policyRegistry: "0xa2177e6d8682367637a3c2af53e2cf8088efa954",
    spendIntentRegistry: "0x9c1f89dfddd9ae1f9adda4b30ff338e2aa2db202",
    receipts: "0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95",
    vaultFactory: "0x6cc3bc686a7bc554dbd5636cb3eeee9171036805",
  },
};

/** The deployed base contracts for a chain, or throw (never silently returns another network's set). */
export function contractsForChain(chainId: number): DeployedContracts {
  const c = CONTRACTS_BY_CHAIN[chainId];
  if (!c) {
    throw new Error(
      `No deployed Untch contracts recorded for chainId ${chainId} — supported: ${Object.keys(CONTRACTS_BY_CHAIN).join(", ")} (see chains.ts CONTRACTS_BY_CHAIN / deployments/).`,
    );
  }
  return c;
}

/**
 * Single network-selection source. Every service/library/script that talks to X Layer resolves its
 * chain, RPC, and token addresses through the functions below — driven by ONE env contract:
 *
 *   CHAIN_ID   — the numeric chainId ("196" | "1952"), OR
 *   NETWORK    — the CAIP-2 form ("eip155:196" | "eip155:1952").
 *
 * CHAIN_ID wins when both are set; when neither is set a consumer's own fallback applies (the library
 * packages fall back to testnet, the ASP seller falls back to mainnet — that is the only per-consumer
 * knob, the selection mechanism is identical). RPC_URL, when set, overrides the chain's default RPC.
 */
/** Production default is X Layer mainnet (196). Set CHAIN_ID=1952 / NEXT_PUBLIC_CHAIN_ID=1952 for testnet. */
export const DEFAULT_CHAIN_ID: number = X_LAYER_MAINNET_ID;

/**
 * The env bag the selection functions read from. The index signature is load-bearing: every caller
 * passes a whole `process.env`, whose only nominal property is Next's `NODE_ENV` augmentation. Without
 * it, an all-optional `ChainEnv` is a *weak type*, and passing `process.env` fails TS's weak-type check
 * ("no properties in common") wherever those augmented node types are in scope — apps/web, but not the
 * root config that CI runs.
 */
export type ChainEnv = {
  CHAIN_ID?: string | undefined;
  NETWORK?: string | undefined;
  RPC_URL?: string | undefined;
  [key: string]: string | undefined;
};

/** Parse a CHAIN_ID ("196") or NETWORK ("eip155:196") string to a supported chainId, or throw. */
export function parseChainId(raw: string): number {
  const match = raw.trim().match(/(\d+)\s*$/);
  const id = match ? Number(match[1]) : Number.NaN;
  if (!(id in CHAINS)) {
    throw new Error(
      `Unsupported CHAIN_ID/NETWORK ${JSON.stringify(raw)} — supported: ${Object.keys(CHAINS).join(
        ", ",
      )}`,
    );
  }
  return id;
}

/** The active chainId from env (CHAIN_ID, then NETWORK), else the caller's fallback. */
export function resolveChainId(
  env: ChainEnv = process.env,
  fallback: number = DEFAULT_CHAIN_ID,
): number {
  const raw = env.CHAIN_ID?.trim() || env.NETWORK?.trim();
  return raw ? parseChainId(raw) : fallback;
}

/** The chain config for a known chainId, or throw (never silently falls back). */
export function chainById(chainId: number): Chain {
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  if (!chain) {
    throw new Error(
      `Unsupported chainId ${chainId} — supported: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return chain;
}

/** The active chain from env selection. */
export function activeChain(
  env: ChainEnv = process.env,
  fallback: number = DEFAULT_CHAIN_ID,
): Chain {
  return chainById(resolveChainId(env, fallback));
}

/** The active RPC URL: an explicit RPC_URL override wins, else the active chain's default RPC. */
export function activeRpcUrl(
  env: ChainEnv = process.env,
  fallback: number = DEFAULT_CHAIN_ID,
): string {
  return env.RPC_URL?.trim() || activeChain(env, fallback).rpcUrls.default.http[0]!;
}
