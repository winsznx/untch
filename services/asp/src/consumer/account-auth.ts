/**
 * The ACCOUNT session — a wallet proving who it is, without naming a policy.
 *
 * WHY THIS IS NOT THE EXISTING SIWE ROUTE
 *
 * `authenticateSiwe` mints a session scoped to ONE policy, and it does so by requiring
 * `untch:policy:<id>` in the message's Resources and checking the signer against that policy's
 * on-chain owner. That is exactly right for reading a policy's intents, and it makes three things
 * impossible:
 *
 *   • signing in BEFORE you have a policy. A new user has no policy id to name, so the route that
 *     would let them create one is behind an authentication that requires one to already exist.
 *   • seeing more than one policy at a time. The session IS a policy, so "my policies" has no subject.
 *   • binding a marketplace identity. There is nowhere on a policy-scoped session for it to attach.
 *
 * So this is a second, narrower proof: the same signature machinery, the same single-use server-issued
 * nonce, the same domain and chain binding — resolving to an ACCOUNT rather than to a policy. Policy
 * authority is then a property of the account's bindings, checked per policy at the moment it matters,
 * instead of being baked into the token at sign-in.
 *
 * TOKENS OF THE TWO KINDS ARE NOT INTERCHANGEABLE
 *
 * Both are HMAC'd with the same secret, so without a domain separator a policy session's bytes would
 * open as an account session and vice versa — and the two carry different authority. The MAC here is
 * computed over a tagged payload, and `openAccountSession` re-checks the tag after verifying, so a
 * token minted by the other route fails the MAC rather than being decoded into a shape it was never
 * issued as.
 *
 * WHAT THE PROOF METHOD IS, AND WHY IT IS THE ONE AVAILABLE
 *
 * SIWE over personal_sign (EIP-191). The OKX Agentic Wallet documents `wallet sign-message` with
 * `--type personal` for EVM, which is precisely what SIWE verification consumes — so this is a path the
 * installed wallet actually supports, not one assumed from a family resemblance to other wallets. No
 * new contract is deployed and no on-chain transaction is required to establish an identity.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";
import { SIGNIN_CHAIN_IDS, signInRefusal } from "@untch/shared";
import type { BindingScope } from "@untch/consumer-core";
import type { SiweVerifier } from "./auth";

const ACCOUNT_SESSION_TTL_MS = 30 * 60_000;

/** The domain separator. Present in the MAC input, so a policy-session token cannot be opened here. */
const TAG = "untch.account.v1";

export interface AccountSession {
  readonly kind: "account";
  readonly accountId: string;
  readonly address: Address;
  /** The wallet binding this session was minted from. Revoking it does not retroactively kill the
   *  token — it lives for minutes — but every authority check re-reads the binding, so a revoked
   *  wallet stops being able to act well before the token expires on its own. */
  readonly bindingId: string;
  readonly scopes: readonly BindingScope[];
  readonly expiresAt: number;
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`${TAG}.${payload}`).digest("base64url");
}

export function sealAccountSession(secret: string, session: AccountSession): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

/**
 * Open a token, or return null. Never throws, and never distinguishes tampered from malformed — both
 * are simply not a session, and telling them apart is free information for whoever is probing.
 */
export function openAccountSession(
  secret: string,
  token: string | undefined,
  nowMs: number,
): AccountSession | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(mac(secret, payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccountSession;
    if (parsed.kind !== "account") return null;
    if (typeof parsed.accountId !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (parsed.expiresAt <= nowMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function mintAccountSession(args: {
  readonly secret: string;
  readonly accountId: string;
  readonly address: Address;
  readonly bindingId: string;
  readonly scopes: readonly BindingScope[];
  readonly nowMs: number;
}): { readonly session: AccountSession; readonly token: string } {
  const session: AccountSession = {
    kind: "account",
    accountId: args.accountId,
    address: args.address,
    bindingId: args.bindingId,
    scopes: args.scopes,
    expiresAt: args.nowMs + ACCOUNT_SESSION_TTL_MS,
  };
  return { session, token: sealAccountSession(args.secret, session) };
}

// ── the wallet proof ─────────────────────────────────────────────────────────

export interface WalletProof {
  readonly address: Address;
  readonly chainId: number;
  /** The nonce the message named — the value that must equal the link request's own. */
  readonly nonce: string;
}

export type WalletProofOutcome =
  | { readonly ok: true; readonly proof: WalletProof }
  | { readonly ok: false; readonly code: string; readonly reason: string };

const SIGNIN_CHAINS = new Set<number>(SIGNIN_CHAIN_IDS);

/**
 * Verify a SIWE message against a nonce this server already committed to.
 *
 * `expectedNonce` is the discriminator that makes the whole link flow safe. The link request stored a
 * nonce when it was created; a signature that names any other nonce is a signature obtained for some
 * other purpose, and accepting it would let a message the user signed elsewhere complete a binding they
 * never saw. The check is here rather than at the call site because a caller that forgot it would
 * produce a flow that works perfectly in every honest test.
 *
 * Order is cheap-before-expensive and safe-before-informative: structure, domain, chain, message
 * expiry, nonce match, then the signature — which may cost an RPC round trip for a contract wallet.
 */
export async function verifyWalletProof(
  args: {
    readonly message: string;
    readonly signature: Hex;
    readonly expectedNonce: string;
    readonly domain: string;
    readonly nowMs: number;
  },
  verifier: SiweVerifier,
): Promise<WalletProofOutcome> {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(args.message);
  } catch {
    return { ok: false, code: "SIWE_MALFORMED", reason: "the message is not a valid SIWE message" };
  }

  if (!parsed.address) return { ok: false, code: "SIWE_NO_ADDRESS", reason: "the message names no address" };
  if (!parsed.nonce) return { ok: false, code: "SIWE_NO_NONCE", reason: "the message carries no nonce" };

  if (parsed.domain !== args.domain) {
    return {
      ok: false,
      code: "SIWE_WRONG_DOMAIN",
      reason: `the message was signed for ${parsed.domain ?? "(none)"}, not ${args.domain}`,
    };
  }
  if (parsed.chainId === undefined || !SIGNIN_CHAINS.has(parsed.chainId)) {
    return {
      ok: false,
      code: "SIWE_WRONG_CHAIN",
      reason:
        (parsed.chainId === undefined ? null : signInRefusal(parsed.chainId)) ??
        `sign-in must name an X Layer chain (${SIGNIN_CHAIN_IDS.join(" or ")})`,
    };
  }
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= args.nowMs) {
    return { ok: false, code: "SIWE_EXPIRED", reason: "the message's own expirationTime has passed" };
  }
  if (parsed.notBefore && parsed.notBefore.getTime() > args.nowMs) {
    return { ok: false, code: "SIWE_NOT_YET_VALID", reason: "the message's notBefore is in the future" };
  }
  if (parsed.nonce !== args.expectedNonce) {
    return {
      ok: false,
      code: "SIWE_NONCE_MISMATCH",
      reason:
        "the message names a different nonce than this link request issued; a signature produced for " +
        "another purpose cannot complete this binding",
    };
  }

  const valid = await verifier.verify({
    message: args.message,
    signature: args.signature,
    nonce: parsed.nonce,
    domain: args.domain,
  });
  if (!valid) return { ok: false, code: "SIWE_BAD_SIGNATURE", reason: "the signature did not verify" };

  return { ok: true, proof: { address: parsed.address, chainId: parsed.chainId, nonce: parsed.nonce } };
}

/**
 * The message a wallet is asked to sign, built server-side.
 *
 * Built here and returned to the caller rather than left to the client to compose, because every field
 * in it is a binding this server later checks — domain, chain id, nonce, expiry. A client that composed
 * its own would be free to omit one, and the omission would only surface as a refusal the user cannot
 * act on.
 */
export function buildLinkMessage(args: {
  readonly domain: string;
  readonly uri: string;
  readonly address: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}): string {
  return [
    `${args.domain} wants you to sign in with your Ethereum account:`,
    args.address,
    "",
    // Deliberately says what this signature does and does not do. A user who is told only "sign in"
    // has no way to notice if a future message quietly asks for more.
    "Link this wallet to your Untch account. This proves who you are. It does not approve any payment.",
    "",
    `URI: ${args.uri}`,
    "Version: 1",
    `Chain ID: ${args.chainId}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt}`,
    `Expiration Time: ${args.expiresAt}`,
    "Resources:",
    ...args.scopes.map((s) => `- untch:scope:${s}`),
  ].join("\n");
}
