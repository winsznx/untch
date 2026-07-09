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
