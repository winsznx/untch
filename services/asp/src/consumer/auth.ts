/**
 * Ownership proof for tenant-scoped consumer reads.
 *
 * THE HOLE THIS CLOSES. Scope came from `?policyId=`, and the code justified it by observing that a
 * policy id is bound to an owner wallet on chain. The binding is real; it was simply never checked.
 * A policy id is public on-chain data, so anyone who read one off the explorer could pass it and
 * receive that tenant's intent amounts, provider, policy decisions, and — through the SSE stream —
 * their entire lifecycle as it happened. Deriving a tenant from a public identifier is not
 * authorisation, it is namespacing.
 *
 * WHAT REPLACES IT. A SIWE signature over a server-issued nonce, verified against the policy's
 * on-chain owner, exchanged for a short-lived bearer token. Three properties do the work:
 *
 *   • the nonce is SERVER-ISSUED, so a caller cannot pre-sign;
 *   • it is SINGLE-USE, enforced by a conditional UPDATE rather than read-then-write, so two
 *     concurrent replays cannot both win;
 *   • it EXPIRES, so a captured message has a bounded life even before it is consumed.
 *
 * The token is stateless and HMAC-signed rather than a session row. It is derived from a signature
 * that was already verified, it lives for minutes, and revocation is a secret rotation — a session
 * table would add a write to every request to defend a window that short.
 *
 * WHAT STAYS PUBLIC. `/consumer/receipt/:intentId` never consults any of this. A receipt nobody can
 * share is not a receipt, and that view is built by naming publishable fields, so it has nothing to
 * protect.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseSiweMessage } from "viem/siwe";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { SIGNIN_CHAIN_IDS, signInRefusal } from "@untch/shared";
import type { PolicyProvider } from "@untch/policy-store";
import type { Pool } from "@untch/consumer-core";
import { tenantForPolicy } from "./tenant";

/**
 * Which chains a sign-in may name — asked of the shared registry, never retyped here.
 *
 * It was retyped here, and the retyped value was 195: the DEPRECATED original X Layer testnet, which
 * has no live RPC. So this route accepted signatures for a chain nothing can reach and refused the
 * one that answers. Sign-in is identity and the same key signs on every chain, so the harm was not a
 * misdirected payment — it was that the accepted set was decided in a file that had no way of knowing
 * `chains.ts` had already recorded 195 as retired.
 */
const SIGNIN_CHAINS = new Set<number>(SIGNIN_CHAIN_IDS);

const NONCE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 60_000;

/** `untch:policy:<id>` and `untch:agent:<id>` in the SIWE `Resources:` block. */
const POLICY_RESOURCE = /^untch:policy:(.+)$/;
const AGENT_RESOURCE = /^untch:agent:(.+)$/;

export interface ConsumerSession {
  readonly address: Address;
  readonly policyId: string;
  readonly agentId: string | null;
  readonly tenantId: string;
  /** Unix ms. */
  readonly expiresAt: number;
}

export type AuthOutcome =
  | { readonly ok: true; readonly session: ConsumerSession; readonly token: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface ConsumerAuthConfig {
  /** HMAC key for session tokens. Absent ⇒ tokens cannot be minted and auth cannot be enforced. */
  readonly secret: string | null;
  /** The domain a SIWE message must name. A signature for another site must not work here. */
  readonly domain: string;
  /**
   * When true, a scoped read REQUIRES a verified bearer and `?policyId=` is refused outright.
   *
   * Left off, a bearer still wins where present and the unproven query path keeps working, so an
   * existing integration is not broken by a deploy. The boot log says loudly which mode is live —
   * an authorisation control that is silently off is worse than one that is absent.
   */
  readonly required: boolean;
}

export function loadConsumerAuthConfig(env: NodeJS.ProcessEnv = process.env): ConsumerAuthConfig {
  const secret = (env.CONSUMER_AUTH_SECRET?.trim() || env.AUTH_SECRET?.trim()) ?? "";
  const base = env.CONSUMER_PUBLIC_BASE_URL?.trim() || env.PUBLIC_BASE_URL?.trim() || "https://asp.untch.xyz";
  let domain = "asp.untch.xyz";
  try {
    domain = new URL(base).host;
  } catch {
    // A malformed base URL must not silently widen the audience a signature is accepted for; the
    // default above is the production host, which is strictly narrower than accepting anything.
  }
  const required = env.CONSUMER_AUTH_REQUIRED === "1" || env.CONSUMER_AUTH_REQUIRED === "true";
  return { secret: secret.length > 0 ? secret : null, domain, required };
}

// ── nonce store ───────────────────────────────────────────────────────────────

export interface NonceStore {
  issue(address: string | null, nowMs: number): Promise<{ nonce: string; expiresAt: string }>;
  /** Consumes the nonce and reports whether THIS call is the one that consumed it. */
  consume(nonce: string, nowMs: number): Promise<boolean>;
  sweep(nowMs: number): Promise<number>;
}

export class PgNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  async issue(address: string | null, nowMs: number): Promise<{ nonce: string; expiresAt: string }> {
    // SIWE nonces are alphanumeric by spec; hex satisfies that and carries 128 bits.
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(nowMs + NONCE_TTL_MS).toISOString();
    await this.pool.query(
      "INSERT INTO consumer_auth_nonces (nonce, address, issued_at, expires_at) VALUES ($1,$2,$3,$4)",
      [nonce, address, new Date(nowMs).toISOString(), expiresAt],
    );
    return { nonce, expiresAt };
  }

  /**
   * One conditional UPDATE, not a SELECT then an UPDATE.
   *
   * Two concurrent replays of the same signature both pass a read-then-write; only one can win a
   * `WHERE consumed_at IS NULL` update. `rowCount === 1` IS the proof that this call consumed it.
   */
  async consume(nonce: string, nowMs: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE consumer_auth_nonces
          SET consumed_at = $2
        WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2`,
      [nonce, new Date(nowMs).toISOString()],
    );
    return (rowCount ?? 0) === 1;
  }

  async sweep(nowMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM consumer_auth_nonces WHERE expires_at < $1",
      [new Date(nowMs - NONCE_TTL_MS).toISOString()],
    );
    return rowCount ?? 0;
  }
}

/** For tests and for a deployment with no database — same single-use semantics. */
export class InMemoryNonceStore implements NonceStore {
  private readonly rows = new Map<string, { expiresAt: number; consumed: boolean }>();

  async issue(_address: string | null, nowMs: number): Promise<{ nonce: string; expiresAt: string }> {
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = nowMs + NONCE_TTL_MS;
    this.rows.set(nonce, { expiresAt, consumed: false });
    return { nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consume(nonce: string, nowMs: number): Promise<boolean> {
    const row = this.rows.get(nonce);
    if (!row || row.consumed || row.expiresAt <= nowMs) return false;
    row.consumed = true;
    return true;
  }

  async sweep(nowMs: number): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) {
      if (v.expiresAt < nowMs - NONCE_TTL_MS) {
        this.rows.delete(k);
        n += 1;
      }
    }
    return n;
  }
}

// ── token sealing ─────────────────────────────────────────────────────────────

const b64url = (buf: Buffer): string => buf.toString("base64url");

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sealSession(secret: string, session: ConsumerSession): string {
  const payload = b64url(Buffer.from(JSON.stringify(session), "utf8"));
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * Opens a token, or returns null. Never throws and never distinguishes "tampered" from "malformed"
 * to the caller — both are simply not a session, and telling them apart is free information.
 */
export function openSession(secret: string, token: string | undefined, nowMs: number): ConsumerSession | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(secret, payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConsumerSession;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= nowMs) return null;
    if (typeof parsed.policyId !== "string" || typeof parsed.tenantId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Re-exported rather than restated. `tenant.ts` is the one formula; this name is kept because the
 * SIWE path and its tests have always called it this, and a rename would be churn with no reader.
 */
export { tenantForPolicy };

// ── SIWE verification ─────────────────────────────────────────────────────────

/**
 * Moved to `siwe-verifier.ts` so the Cloudflare account-link routes can import the verifier without
 * dragging this module — the config loader, the nonce store and `tenantForPolicy` — into a Worker
 * bundle. Re-exported so every existing caller is unchanged and there is still one definition.
 */
import type { SiweVerifier } from "./siwe-verifier";
export { makeSiweVerifier, type SiweVerifier } from "./siwe-verifier";

function resourceValue(resources: readonly string[] | undefined, re: RegExp): string | null {
  for (const r of resources ?? []) {
    const m = re.exec(r);
    if (m?.[1]) return m[1];
  }
  return null;
}

export interface AuthenticateDeps {
  readonly config: ConsumerAuthConfig;
  readonly nonces: NonceStore;
  readonly verifier: SiweVerifier;
  readonly policyProvider: PolicyProvider;
  readonly now?: () => number;
}

/**
 * Verify a SIWE message and mint a session.
 *
 * The order of checks is deliberate and each one is cheap-before-expensive AND
 * safe-before-informative:
 *
 *   1. structural — is this even a SIWE message naming an address and a policy
 *   2. domain     — was it signed for THIS site
 *   3. chain      — is it an X Layer chain
 *   4. expiry     — has the message's own expirationTime passed
 *   5. nonce      — consume it, atomically, BEFORE verifying the signature
 *   6. signature  — the expensive step, possibly an RPC call for EIP-1271
 *   7. ownership  — does the recovered address actually own this policy
 *
 * Step 5 before step 6 is the one worth defending. Consuming the nonce first means a caller cannot
 * use signature verification as a free oracle by replaying with variations: every attempt burns the
 * nonce whether or not the signature was valid. It costs a wasted nonce on an honest failure, which
 * is a round trip; the alternative costs an unbounded number of verification attempts per nonce.
 */
export async function authenticateSiwe(
  args: { message: string; signature: Hex },
  deps: AuthenticateDeps,
): Promise<AuthOutcome> {
  const now = deps.now?.() ?? Date.now();
  if (!deps.config.secret) {
    return {
      ok: false,
      code: "AUTH_NOT_CONFIGURED",
      reason: "CONSUMER_AUTH_SECRET (or AUTH_SECRET) is unset, so this instance cannot mint sessions",
    };
  }

  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(args.message);
  } catch {
    return { ok: false, code: "SIWE_MALFORMED", reason: "the message is not a valid SIWE message" };
  }

  const address = parsed.address;
  if (!address) return { ok: false, code: "SIWE_NO_ADDRESS", reason: "the message names no address" };
  if (!parsed.nonce) return { ok: false, code: "SIWE_NO_NONCE", reason: "the message carries no nonce" };

  const policyId = resourceValue(parsed.resources, POLICY_RESOURCE);
  if (!policyId) {
    return {
      ok: false,
      code: "SIWE_NO_POLICY_RESOURCE",
      reason: "the message must bind a policy: add `untch:policy:<policyId>` to its Resources",
    };
  }
  const agentId = resourceValue(parsed.resources, AGENT_RESOURCE);

  if (parsed.domain !== deps.config.domain) {
    // A signature produced for another site must not be usable here, regardless of how valid it is.
    return {
      ok: false,
      code: "SIWE_WRONG_DOMAIN",
      reason: `the message was signed for ${parsed.domain ?? "(none)"}, not ${deps.config.domain}`,
    };
  }
  if (parsed.chainId === undefined) {
    return { ok: false, code: "SIWE_WRONG_CHAIN", reason: "sign-in must name an X Layer chain" };
  }
  if (!SIGNIN_CHAINS.has(parsed.chainId)) {
    // Named rather than generic: someone holding a 195 signature needs to be told the chain was
    // retired and which id replaced it, not that their message failed an unspecified check.
    return {
      ok: false,
      code: "SIWE_WRONG_CHAIN",
      reason: signInRefusal(parsed.chainId) ?? "sign-in must name an X Layer chain",
    };
  }
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= now) {
    return { ok: false, code: "SIWE_EXPIRED", reason: "the message's own expirationTime has passed" };
  }
  if (parsed.notBefore && parsed.notBefore.getTime() > now) {
    return { ok: false, code: "SIWE_NOT_YET_VALID", reason: "the message's notBefore is in the future" };
  }

  const fresh = await deps.nonces.consume(parsed.nonce, now);
  if (!fresh) {
    return {
      ok: false,
      code: "SIWE_NONCE_REPLAYED",
      reason: "that nonce was already used, has expired, or was not issued by this server",
    };
  }

  const valid = await deps.verifier.verify({
    message: args.message,
    signature: args.signature,
    nonce: parsed.nonce,
    domain: deps.config.domain,
  });
  if (!valid) return { ok: false, code: "SIWE_BAD_SIGNATURE", reason: "the signature did not verify" };

  const stored = await deps.policyProvider.loadStored(policyId);
  if (!stored) return { ok: false, code: "POLICY_NOT_FOUND", reason: `no stored policy ${policyId}` };
  if (stored.owner.toLowerCase() !== address.toLowerCase()) {
    /**
     * The check the query parameter never made.
     *
     * A valid signature from a real wallet proves who is asking. It does not, on its own, entitle
     * them to this policy's intents — that is exactly the conflation the old scoping made.
     */
    return {
      ok: false,
      code: "NOT_POLICY_OWNER",
      reason: `${address} does not own policy ${policyId}`,
    };
  }

  const session: ConsumerSession = {
    address,
    policyId,
    agentId,
    tenantId: tenantForPolicy(policyId),
    expiresAt: now + SESSION_TTL_MS,
  };
  return { ok: true, session, token: sealSession(deps.config.secret, session) };
}

// ── request-time scope resolution ─────────────────────────────────────────────

export type ScopeResolution =
  /** A verified session. `policyId` came from a signature over a server-issued nonce. */
  | { readonly kind: "PROVEN"; readonly policyId: string; readonly session: ConsumerSession }
  /** A query parameter, accepted only while `required` is off. Namespacing, not authorisation. */
  | { readonly kind: "UNPROVEN"; readonly policyId: string }
  | { readonly kind: "NONE"; readonly code: string; readonly reason: string };

export function resolveScope(
  args: { authorization: string | undefined; queryPolicyId: string | null },
  config: ConsumerAuthConfig,
  nowMs: number,
): ScopeResolution {
  const bearer = /^Bearer\s+(.+)$/i.exec(args.authorization ?? "")?.[1];
  if (config.secret && bearer) {
    const session = openSession(config.secret, bearer, nowMs);
    if (session) return { kind: "PROVEN", policyId: session.policyId, session };
    return { kind: "NONE", code: "SESSION_INVALID", reason: "the bearer token is invalid or expired" };
  }

  if (config.required) {
    return {
      kind: "NONE",
      code: "AUTH_REQUIRED",
      reason:
        "this read is tenant-scoped and requires a session: POST /consumer/auth/nonce, sign the " +
        "SIWE message with the policy owner's wallet, then POST /consumer/auth/verify",
    };
  }

  if (args.queryPolicyId === null) {
    return { kind: "NONE", code: "SCOPE_REQUIRED", reason: "policyId is required" };
  }
  return { kind: "UNPROVEN", policyId: args.queryPolicyId };
}

/** Boot-time line so an operator can see, in the logs, which mode is actually live. */
export function describeAuthMode(config: ConsumerAuthConfig): string {
  if (!config.secret) {
    return "[consumer] auth NOT configured (CONSUMER_AUTH_SECRET unset) — scoped reads fall back to " +
      "an UNPROVEN ?policyId=, which is namespacing and not authorisation";
  }
  return config.required
    ? `[consumer] auth REQUIRED — scoped reads need a SIWE session for domain ${config.domain}; ?policyId= is refused`
    : `[consumer] auth OPTIONAL — a SIWE session for ${config.domain} is honoured where present, but an ` +
      "UNPROVEN ?policyId= is still accepted. Set CONSUMER_AUTH_REQUIRED=1 to close that path.";
}
