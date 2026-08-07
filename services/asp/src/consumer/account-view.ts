/**
 * The published shape of an account and its bindings, with no transport attached.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * These projections lived in `account-routes.ts`, which imports Express. The Cloudflare Worker needs
 * the projections and cannot have Express: pulling that module in dragged `raw-body` and `iconv-lite`
 * into the bundle, and `iconv-lite` calls `require_streams(...)` at module scope, which is not a
 * function under workerd. The Worker built cleanly and then died on deploy with a TypeError before
 * serving anything — the dry run proves a bundle BUILDS, only a deploy proves one STARTS.
 *
 * Splitting them out is also the right shape independently. Deciding which fields of a wallet binding
 * are publishable is a domain question, not an HTTP one, and both transports must answer it the same
 * way or the same account describes itself differently depending on who served it.
 */

import type {
  ChannelBinding,
  MarketplaceBinding,
  UntchAccount,
  WalletBinding,
} from "@untch/consumer-core";

export function publicWallet(w: WalletBinding): Record<string, unknown> {
  return {
    bindingId: w.bindingId,
    chain: w.chainKind,
    network: w.proofChainId === null ? null : `eip155:${w.proofChainId}`,
    address: w.address,
    role: w.role,
    walletProvider: w.walletProvider,
    proofMethod: w.proofKind === "siwe" ? "siwe-personal-sign" : "declared",
    scopes: w.scopes,
    status: w.status,
    verifiedAt: w.verifiedAt,
    revokedAt: w.revokedAt,
  };
}

export function publicMarketplace(m: MarketplaceBinding): Record<string, unknown> {
  return {
    bindingId: m.bindingId,
    marketplace: m.marketplace,
    agentId: m.agentId,
    buyerId: m.buyerId,
    marketplaceUserRef: m.marketplaceUserRef,
    serviceOrderRef: m.serviceOrderRef,
    taskRef: m.taskRef,
    bindingMethod: m.bindingMethod,
    // Named rather than implied. A binding that authorises nothing must SAY it authorises nothing,
    // because a client that sees only `status: ACTIVE` will reasonably assume otherwise.
    carriesAuthority: m.provenBy === "wallet-signature",
    status: m.status,
    verifiedAt: m.verifiedAt,
    expiresAt: m.expiresAt,
    revokedAt: m.revokedAt,
  };
}

export function publicChannel(c: ChannelBinding): Record<string, unknown> {
  return {
    bindingId: c.bindingId,
    channel: c.channel,
    // The platform identity is truncated. It is enough to recognise which of your own accounts this
    // is, and not enough for a leaked read to become a target list.
    identity: c.displayLabel ?? `${c.channelUserId.slice(0, 4)}…`,
    canDecide: c.canDecide,
    status: c.status,
    verifiedAt: c.verifiedAt,
    revokedAt: c.revokedAt,
  };
}

/** The published shape of an account. One definition, both transports. */
export function publicAccount(
  account: UntchAccount,
  wallets: readonly WalletBinding[],
  marketplace: readonly MarketplaceBinding[],
  channels: readonly ChannelBinding[],
): Record<string, unknown> {
  return {
    accountId: account.accountId,
    status: account.status,
    displayName: account.displayName,
    defaultPolicyId: account.defaultPolicyId,
    primaryWalletBindingId: account.primaryWalletBindingId,
    createdAt: account.createdAt,
    lastAuthenticatedAt: account.lastAuthenticatedAt,
    wallets: wallets.map(publicWallet),
    marketplaceBindings: marketplace.map(publicMarketplace),
    channelBindings: channels.map(publicChannel),
  };
}

/**
 * The Discord interactions path, here because the Worker route needs it and the module that owned it
 * imports Express for the same reason `account-routes` does.
 */
export const DISCORD_INTERACTIONS_PATH = "/consumer/approvals/action/discord/interactions" as const;
