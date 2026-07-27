/**
 * The Consumer Pack asset + chain registry.
 *
 * This deliberately copies the discipline of `packages/shared/src/chains.ts`: an asset is either
 * CONFIRMED — with an address read from an official/live source, and a recorded provenance string —
 * or UNCONFIRMED, in which case it carries `address: null` plus the reason it could not be confirmed,
 * and is excluded from every allowlist BY CONSTRUCTION rather than by a reviewer remembering to
 * exclude it.
 *
 * Provenance for the Consumer Pack's own additions is stronger than documentation: every address
 * below marked "live x402 challenge" was read out of an actual HTTP 402 response captured on
 * 2026-07-27 and committed under internal/consumer-pack-evidence/. A token address that a real
 * merchant is actively demanding payment in is about as confirmed as an address gets.
 */

import { X_LAYER_MAINNET_ID, TOKENS, isConfirmed as isSharedConfirmed } from "@untch/shared";

/** CAIP-2 chain identifier. The single form used everywhere in the Consumer Pack. */
export type CaipChainId = `${string}:${string}`;

export const X_LAYER_MAINNET: CaipChainId = "eip155:196";
export const BASE_MAINNET: CaipChainId = "eip155:8453";
/** Solana mainnet-beta, CAIP-2 (genesis-hash prefix). Read from live x402 challenges. */
export const SOLANA_MAINNET: CaipChainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** Tempo. chainId 4217 read from a live MPP `WWW-Authenticate: Payment` methodDetails. */
export const TEMPO_MAINNET: CaipChainId = "eip155:4217";

/** How a chain's payments are constructed. Drives which rail client can serve a challenge. */
export type ChainFamily = "evm" | "solana";

export interface ChainProfile {
  readonly chain: CaipChainId;
  readonly family: ChainFamily;
  readonly name: string;
  /** Numeric EVM chainId; null on non-EVM families. */
  readonly evmChainId: number | null;
  /** Confirmations required before a funding receipt on this chain is treated as final. */
  readonly fundingConfirmations: number;
}

export const CHAIN_PROFILES: Readonly<Record<CaipChainId, ChainProfile>> = Object.freeze({
  [X_LAYER_MAINNET]: {
    chain: X_LAYER_MAINNET,
    family: "evm",
    name: "X Layer",
    evmChainId: X_LAYER_MAINNET_ID,
    fundingConfirmations: 12,
  },
  [BASE_MAINNET]: {
    chain: BASE_MAINNET,
    family: "evm",
    name: "Base",
    evmChainId: 8453,
    fundingConfirmations: 12,
  },
  [SOLANA_MAINNET]: {
    chain: SOLANA_MAINNET,
    family: "solana",
    name: "Solana",
    evmChainId: null,
    fundingConfirmations: 32,
  },
  [TEMPO_MAINNET]: {
    chain: TEMPO_MAINNET,
    family: "evm",
    name: "Tempo",
    evmChainId: 4217,
    fundingConfirmations: 12,
  },
});

export function chainProfile(chain: CaipChainId): ChainProfile {
  const p = CHAIN_PROFILES[chain];
  if (!p) {
    throw new Error(
      `unsupported chain ${chain} — supported: ${Object.keys(CHAIN_PROFILES).join(", ")} ` +
        "(see packages/consumer-core/src/assets.ts)",
    );
  }
  return p;
}

/** A fully identified asset. `address` is a contract address (EVM) or an SPL mint (Solana). */
export interface AssetRef {
  readonly symbol: string;
  readonly chain: CaipChainId;
  /** Contract address / mint. `null` ONLY for a chain's native coin, which is never a settlement asset here. */
  readonly address: string | null;
  readonly decimals: number;
}

export interface ConfirmedAsset extends AssetRef {
  readonly address: string;
  /** Where the address + decimals came from, with the date. Never blank. */
  readonly confirmedFrom: string;
  /**
   * EIP-712 domain fields the token's EIP-3009 `transferWithAuthorization` signs under. Present only
   * for EVM assets that a live x402 challenge declared an EIP-3009 `extra` for. Absent ⇒ this asset
   * cannot be paid with the exact-EVM scheme and the rail client refuses rather than guessing.
   */
  readonly eip3009?: { readonly name: string; readonly version: string };
}

export interface UnconfirmedAsset {
  readonly symbol: string;
  readonly chain: CaipChainId;
  readonly address: null;
  readonly decimals: null;
  readonly reason: string;
}

export type AssetEntry = ConfirmedAsset | UnconfirmedAsset;

export function isConfirmedAsset(a: AssetEntry): a is ConfirmedAsset {
  return a.address !== null;
}

/** Canonical identity key for an asset. Case-insensitive on address, exact on chain. */
export function assetKey(a: AssetRef): string {
  return `${a.chain}|${(a.address ?? "native").toLowerCase()}`;
}

/** Loggable description. Deliberately omits the full address (see the redaction rules). */
export function describeAsset(a: AssetRef): string {
  return `${a.symbol}@${a.chain}`;
}

const xLayerUsdt0 = TOKENS[X_LAYER_MAINNET_ID].USDT0;

/**
 * The Consumer Pack asset registry.
 *
 * X Layer USDT0 is re-derived from @untch/shared rather than re-typed, so the funding rail can never
 * drift from the address the rest of Untch settles on.
 */
export const ASSETS: Readonly<Record<string, AssetEntry>> = Object.freeze({
  "xlayer.usdt0": isSharedConfirmed(xLayerUsdt0)
    ? {
        symbol: "USDT0",
        chain: X_LAYER_MAINNET,
        address: xLayerUsdt0.address,
        decimals: xLayerUsdt0.decimals,
        confirmedFrom: `re-exported from @untch/shared TOKENS[196].USDT0 — ${xLayerUsdt0.confirmedFrom}`,
        // No `eip3009` domain: Untch never SIGNS on this asset. It is the INBOUND funding rail — the
        // paying agent signs the EIP-3009 authorization and the OKX facilitator submits it, exactly as
        // ping/preflight already work. Inventing a domain here would be an unverified guess with no
        // caller, and its absence correctly makes the outbound EVM rail client refuse this asset.
      }
    : {
        symbol: "USDT0",
        chain: X_LAYER_MAINNET,
        address: null,
        decimals: null,
        reason: "@untch/shared reports X Layer USDT0 as unconfirmed",
      },

  "base.usdc": {
    symbol: "USDC",
    chain: BASE_MAINNET,
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    confirmedFrom:
      "Live x402 402 challenges from stabledomains.dev (/api/check, /api/register) and stableemail.dev " +
      "(/api/send) on 2026-07-27 both name this asset on eip155:8453 with extra {name:'USD Coin',version:'2'}; " +
      "amounts are 6-decimal (e.g. '20000000' for the $20.00 register price). See " +
      "internal/consumer-pack-evidence/probe-paid-endpoints-2026-07-27.json.",
    eip3009: { name: "USD Coin", version: "2" },
  },

  "solana.usdc": {
    symbol: "USDC",
    chain: SOLANA_MAINNET,
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    confirmedFrom:
      "Live x402 402 challenges from api.purch.xyz (/x402/search, /x402/vault/download), stabledomains.dev " +
      "and stableemail.dev on 2026-07-27 all name this mint on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp " +
      "with 6-decimal amounts. See internal/consumer-pack-evidence/.",
  },

  "tempo.mpp": {
    symbol: "MPP-CURRENCY",
    chain: TEMPO_MAINNET,
    address: null,
    decimals: null,
    reason:
      "UNCONFIRMED: the live MPP `WWW-Authenticate: Payment` header advertises currency " +
      "0x20c000000000000000000000b9537d11c60e8b50 with methodDetails.chainId 4217, but that value is an " +
      "MPP currency identifier whose encoding (and whether it is an ERC-20 address at all) could not be " +
      "confirmed from an official source. Its decimals are therefore unknown. Not guessed — the Tempo/MPP " +
      "rail stays non-executable until this is confirmed.",
  },
});

export function asset(key: string): ConfirmedAsset {
  const entry = ASSETS[key];
  if (!entry) throw new Error(`unknown asset key ${JSON.stringify(key)}`);
  if (!isConfirmedAsset(entry)) {
    throw new Error(`asset ${key} is UNCONFIRMED and cannot be used: ${entry.reason}`);
  }
  return entry;
}

export function maybeAsset(key: string): ConfirmedAsset | null {
  const entry = ASSETS[key];
  return entry && isConfirmedAsset(entry) ? entry : null;
}

/** Every confirmed asset on a chain. UNCONFIRMED entries can never appear here. */
export function confirmedAssetsFor(chain: CaipChainId): readonly ConfirmedAsset[] {
  return Object.values(ASSETS).filter(
    (a): a is ConfirmedAsset => isConfirmedAsset(a) && a.chain === chain,
  );
}

/** Resolve an (chain, address) pair from a provider challenge to a registry asset, or null. */
export function lookupAsset(chain: CaipChainId, address: string): ConfirmedAsset | null {
  const wanted = `${chain}|${address.toLowerCase()}`;
  for (const entry of Object.values(ASSETS)) {
    if (isConfirmedAsset(entry) && assetKey(entry) === wanted) return entry;
  }
  return null;
}

/**
 * The settlement allowlist. A provider challenge naming any (chain, asset) pair outside this set is
 * refused before a signer is ever reached — the "wrong token / wrong chain" control from the threat
 * model, enforced as data rather than as a code path someone must remember to write.
 */
export function settlementAllowlist(): readonly ConfirmedAsset[] {
  return Object.values(ASSETS).filter(isConfirmedAsset);
}

export function isAllowedSettlementAsset(chain: CaipChainId, address: string): boolean {
  return lookupAsset(chain, address) !== null;
}
