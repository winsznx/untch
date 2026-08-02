import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "./db";

/**
 * The one-time code that binds an identity, and the request that carries it.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * Untch is hired on OKX by a caller it has never met. The call arrives with an agent id, which is a
 * claim in a header — anyone can send one. Two responses are available and both are wrong: trusting it
 * makes an unauthenticated string into an account, and refusing outright means a marketplace user can
 * never reach the policy they hold in the web dashboard.
 *
 * The third response is this. The service answers `ACCOUNT_LINK_REQUIRED` with a request id and a URL,
 * the same person opens it and signs with the wallet that actually carries authority, and the
 * marketplace identity is bound to the account that signature resolved to. The claim never becomes
 * authority; it becomes a LABEL on an authority that was proven separately.
 *
 * THREE PROPERTIES DO THE WORK
 *
 *   • the code is stored HASHED, so a database backup, a log drain or a support query never carries a
 *     usable credential;
 *   • redemption is a single conditional UPDATE, so two concurrent redemptions cannot both win — the
 *     row count IS the proof that this call consumed it, not a read that a rival could interleave with;
 *   • the request is bound to a SIWE nonce, so the signature that completes it cannot be one obtained
 *     for some other purpose and replayed here.
 *
 * WHAT A LINK CODE CANNOT DO
 *
 * Approve money. There is no amount on this row, no intent and no policy. A credential that both
 * establishes identity and releases funds is a credential whose theft does both, and the separation is
 * structural rather than remembered: spending needs a policy, a quote and — above the threshold — an
 * approval whose digest names the exact amount. None of those are reachable from here.
 */

export type LinkRequestStatus = "PENDING" | "COMPLETED" | "EXPIRED" | "CANCELLED";

/** Ten minutes. Long enough to open a link and sign; short enough that a leaked code is stale fast. */
export const LINK_CODE_TTL_MS = 10 * 60_000;

/** Redemption attempts before a request is burned. A code that can be guessed without limit is a long code and nothing else. */
export const LINK_MAX_ATTEMPTS = 5;

export interface LinkRequestContext {
  readonly marketplace: string | null;
  readonly marketplaceAgentId: string | null;
  readonly marketplaceBuyerId: string | null;
  readonly taskRef: string | null;
  readonly serviceOrderRef: string | null;
}

/**
 * Which wallet product a link request is for.
 *
 * `browser` is completed by the same browser that started it. `agentic` is started in a browser and
 * completed by an AGENT, possibly on another machine and minutes later, so the browser has to poll
 * and the request needs progress states that mean something before a signature exists.
 *
 * They are separate kinds rather than one flexible request because completing an agentic request
 * through the browser path would let an injected extension satisfy a flow the user started expressly
 * to avoid one.
 */
export type LinkKind = "browser" | "agentic";

/** Progress a polling page can render before there is any signature to report. */
export type AgentStage = "WAITING_FOR_AGENT" | "WAITING_FOR_SIGNATURE";

export interface LinkRequest {
  readonly linkRequestId: string;
  readonly accountId: string | null;
  readonly siweNonce: string;
  readonly requestedScopes: readonly string[];
  readonly context: LinkRequestContext;
  readonly returnUrl: string | null;
  readonly status: LinkRequestStatus;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly attempts: number;
  readonly linkKind: LinkKind;
  readonly agentStage: AgentStage | null;
  readonly challengeFetchedAt: string | null;
  /** What the agent said it will sign with, recorded when it fetched the challenge. */
  readonly expectedAddress: string | null;
}

/** A created request, with the code exposed EXACTLY ONCE — it is never readable again from anywhere. */
export interface CreatedLinkRequest {
  readonly request: LinkRequest;
  readonly code: string;
}

/**
 * `ulnk_` + 26 base32 characters, one fresh random byte each — 130 bits. Opaque, unordered, and not
 * derived from anything the caller supplied, so one request id cannot be guessed from another and none
 * of them leaks how many exist.
 */
export function newLinkRequestId(): string {
  return `ulnk_${base32(26)}`;
}

/**
 * The code a human may retype: base32, hyphenated in groups of four, upper case in display.
 *
 * 20 base32 characters, one fresh random byte each — 100 bits. Chosen over a shorter code because this
 * one is sometimes read aloud or pasted into a chat, and the attempt limit is a backstop rather than
 * the defence: a code short enough to need rate limiting to be safe is a code that is unsafe the moment
 * the limiter is bypassed.
 */
export function newLinkCode(): string {
  const raw = base32(20).toUpperCase();
  return (raw.match(/.{1,4}/g) ?? [raw]).join("-");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * ONE fresh byte per character. Never a byte reused by wrapping the index.
 *
 * The version this replaces did `bytes[i % bytes.length]`, which looks harmless and is not: asked for
 * 26 characters from 17 bytes it emitted characters 0–16 and then REPEATED characters 0–8, so every
 * id ended with a visible copy of its own beginning. A production id read back as
 * `ulnk_5c43hxjwpbcn37y445c43hxjwp` — `5c43hxjwp` twice — which is how it was noticed.
 *
 * The damage is not cosmetic. Every id leaked its own suffix from its prefix, and the doc comments
 * claimed randomness the strings did not carry: the tail characters were copies, so they added nothing
 * to the space an attacker has to search. Drawing `length` bytes costs nothing and makes the claim true.
 *
 * `% 32` is bias-free here because 256 is an exact multiple of 32; every character is equally likely.
 */
function base32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE32[(bytes[i] as number) % 32];
  return out;
}

/** Hyphens and case are presentation. Comparison happens on the canonical form so a retyped code works. */
export function canonicaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(canonicaliseCode(code), "utf8").digest("hex");
}

/**
 * Compare two hashes without leaking how far they matched.
 *
 * Both operands are fixed-length hex digests of the same hash, so the length check can only fail on a
 * malformed stored value — but comparing unequal-length buffers throws in `timingSafeEqual`, and a
 * throw here would be an exception where a refusal belongs.
 */
export function codeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(candidate), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Is this return URL one we are willing to send a freshly-authenticated person to?
 *
 * An attacker-chosen return URL turns a link flow into an open redirect with a session at the end of
 * it. The allowlist is by ORIGIN and the comparison is exact — a `startsWith` check on the origin would
 * accept `https://asp.untch.xyz.evil.test`, which is a different host that happens to share a prefix.
 *
 * TLS IS REQUIRED, WITH NO DEVELOPMENT EXEMPTION
 *
 * An earlier draft waved through a plaintext loopback origin so a local dev server could be returned
 * to. The production-surface scanner refused it, and the scanner was right: the exemption is a branch
 * in shipped code whose only job is to relax a transport guarantee, and the condition it keys on is a
 * hostname the request supplies. A deployment wanting a plaintext origin can put one in
 * `allowedOrigins` explicitly and see it in its own configuration, which is the difference between a
 * decision somebody made and a hole nobody noticed.
 */
export function returnUrlAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return allowedOrigins.some((origin) => {
    try {
      return new URL(origin).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

export type RedeemFailure =
  | "NOT_FOUND"
  | "EXPIRED"
  | "ALREADY_COMPLETED"
  | "CANCELLED"
  | "CODE_MISMATCH"
  | "TOO_MANY_ATTEMPTS";

export type RedeemOutcome =
  | { readonly ok: true; readonly request: LinkRequest }
  | { readonly ok: false; readonly reason: RedeemFailure };

export interface LinkRequestStore {
  create(args: {
    readonly requestedScopes: readonly string[];
    readonly context: LinkRequestContext;
    readonly returnUrl: string | null;
    readonly siweNonce: string;
    readonly sourceRequestId: string | null;
    readonly nowMs: number;
    readonly by: string;
    readonly linkKind?: LinkKind;
  }): Promise<CreatedLinkRequest>;
  get(linkRequestId: string): Promise<LinkRequest | null>;
  /**
   * Record that an agent has read the challenge, and with which address it intends to sign.
   *
   * Idempotent: an agent that retries does not reset the first-read timestamp. The address is
   * overwritten on each fetch, because a user who switches sub-wallet mid-flow and re-fetches has
   * genuinely changed their answer, and completion compares against the LAST thing the browser was
   * shown rather than the first.
   */
  markChallengeFetched(args: {
    readonly linkRequestId: string;
    readonly expectedAddress: string | null;
    readonly nowMs: number;
  }): Promise<void>;
  /**
   * Consume the request, atomically, and attach it to `accountId`.
   *
   * The caller must ALREADY have verified the wallet signature. This method's job is the race and the
   * code, not the proof — separating them means a future caller cannot accidentally redeem without a
   * signature by passing a different flag.
   */
  redeem(args: {
    readonly linkRequestId: string;
    readonly code: string;
    readonly accountId: string;
    readonly nowMs: number;
    readonly by: string;
  }): Promise<RedeemOutcome>;
  /**
   * Consume an AGENTIC request on the strength of a verified signature alone.
   *
   * The browser flow has a one-time code because the browser is what completes it and a code is what
   * proves the completer is the same party that started it. An agentic request has no such code: it is
   * completed by an agent that fetched the challenge from a URL, and a code travelling through a
   * copy-pasted prompt would be a bearer secret sitting in a chat log.
   *
   * What replaces it is stronger, not weaker. The caller must ALREADY have verified a signature over
   * THIS request's own single-use nonce, and must have checked the recovered address against the one
   * the browser was shown. There is nothing a code would add to that: a code proves you saw a screen,
   * a signature proves you hold the key.
   *
   * Atomic on `status = 'PENDING'`, so two agents racing produce one consumption and one refusal.
   */
  redeemVerified(args: {
    readonly linkRequestId: string;
    readonly accountId: string;
    readonly nowMs: number;
    readonly by: string;
  }): Promise<RedeemOutcome>;
  cancel(args: { readonly linkRequestId: string; readonly by: string }): Promise<void>;
  expire(nowMs: number): Promise<number>;
}

interface LinkRow {
  link_request_id: string;
  account_id: string | null;
  code_hash: string;
  siwe_nonce: string;
  requested_scopes: string[];
  marketplace: string | null;
  marketplace_agent_id: string | null;
  marketplace_buyer_id: string | null;
  task_ref: string | null;
  service_order_ref: string | null;
  return_url: string | null;
  status: LinkRequestStatus;
  expires_at: Date;
  consumed_at: Date | null;
  attempts: number;
  link_kind: LinkKind;
  agent_stage: AgentStage | null;
  challenge_fetched_at: Date | null;
  expected_address: string | null;
}

function toRequest(row: LinkRow): LinkRequest {
  return {
    linkRequestId: row.link_request_id,
    accountId: row.account_id,
    siweNonce: row.siwe_nonce,
    requestedScopes: row.requested_scopes,
    context: {
      marketplace: row.marketplace,
      marketplaceAgentId: row.marketplace_agent_id,
      marketplaceBuyerId: row.marketplace_buyer_id,
      taskRef: row.task_ref,
      serviceOrderRef: row.service_order_ref,
    },
    returnUrl: row.return_url,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at ? row.consumed_at.toISOString() : null,
    attempts: row.attempts,
    linkKind: row.link_kind ?? "browser",
    agentStage: row.agent_stage ?? null,
    challengeFetchedAt: row.challenge_fetched_at ? row.challenge_fetched_at.toISOString() : null,
    expectedAddress: row.expected_address ?? null,
  };
}

export class PgLinkRequestStore implements LinkRequestStore {
  constructor(private readonly pool: Pool) {}

  async create(args: {
    readonly requestedScopes: readonly string[];
    readonly context: LinkRequestContext;
    readonly returnUrl: string | null;
    readonly siweNonce: string;
    readonly sourceRequestId: string | null;
    readonly nowMs: number;
    readonly by: string;
    readonly linkKind?: LinkKind;
  }): Promise<CreatedLinkRequest> {
    const linkRequestId = newLinkRequestId();
    const code = newLinkCode();
    const linkKind = args.linkKind ?? "browser";
    const { rows } = await this.pool.query<LinkRow>(
      `INSERT INTO untch_account_link_requests
         (link_request_id, code_hash, siwe_nonce, requested_scopes, marketplace, marketplace_agent_id,
          marketplace_buyer_id, task_ref, service_order_ref, return_url, expires_at, source_request_id,
          created_by, updated_by, link_kind, agent_stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15)
       RETURNING *`,
      [
        linkRequestId,
        hashCode(code),
        args.siweNonce,
        [...args.requestedScopes],
        args.context.marketplace,
        args.context.marketplaceAgentId,
        args.context.marketplaceBuyerId,
        args.context.taskRef,
        args.context.serviceOrderRef,
        args.returnUrl,
        new Date(args.nowMs + LINK_CODE_TTL_MS).toISOString(),
        args.sourceRequestId,
        args.by,
        linkKind,
        // An agentic request begins waiting for an agent. A browser request has no agent stage: the
        // browser that started it is the one that will finish it.
        linkKind === "agentic" ? "WAITING_FOR_AGENT" : null,
      ],
    );
    return { request: toRequest(rows[0] as LinkRow), code };
  }

  async markChallengeFetched(args: {
    readonly linkRequestId: string;
    readonly expectedAddress: string | null;
    readonly nowMs: number;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE untch_account_link_requests
          SET agent_stage = 'WAITING_FOR_SIGNATURE',
              -- COALESCE keeps the FIRST read time. A retrying agent has not restarted the flow, and
              -- resetting it would erase how long the user has actually been waiting.
              challenge_fetched_at = COALESCE(challenge_fetched_at, $2),
              expected_address = $3,
              updated_at = now(),
              updated_by = 'agentic-challenge'
        WHERE link_request_id = $1 AND status = 'PENDING'`,
      [args.linkRequestId, new Date(args.nowMs).toISOString(), args.expectedAddress],
    );
  }

  async get(linkRequestId: string): Promise<LinkRequest | null> {
    const { rows } = await this.pool.query<LinkRow>(
      "SELECT * FROM untch_account_link_requests WHERE link_request_id = $1",
      [linkRequestId],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  /**
   * Count the attempt FIRST, then judge.
   *
   * The increment is unconditional and separate, so a wrong code costs an attempt whether or not the
   * request later turns out to be expired. Folding it into the success path would make the limiter
   * count only the attempts that were already going to fail for another reason.
   */
  async redeem(args: {
    readonly linkRequestId: string;
    readonly code: string;
    readonly accountId: string;
    readonly nowMs: number;
    readonly by: string;
  }): Promise<RedeemOutcome> {
    const { rows } = await this.pool.query<LinkRow>(
      `UPDATE untch_account_link_requests
          SET attempts = attempts + 1, updated_at = now(), updated_by = $2
        WHERE link_request_id = $1
        RETURNING *`,
      [args.linkRequestId, args.by],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "NOT_FOUND" };

    if (row.status === "COMPLETED") return { ok: false, reason: "ALREADY_COMPLETED" };
    if (row.status === "CANCELLED") return { ok: false, reason: "CANCELLED" };
    if (row.attempts > LINK_MAX_ATTEMPTS) {
      await this.cancel({ linkRequestId: args.linkRequestId, by: args.by });
      return { ok: false, reason: "TOO_MANY_ATTEMPTS" };
    }
    if (row.expires_at.getTime() <= args.nowMs || row.status === "EXPIRED") {
      return { ok: false, reason: "EXPIRED" };
    }
    if (!codeMatches(args.code, row.code_hash)) return { ok: false, reason: "CODE_MISMATCH" };

    // The completion itself is conditional on the row still being PENDING. Two redemptions that both
    // passed the checks above cannot both land here: only one satisfies `status = 'PENDING'`.
    const completed = await this.pool.query<LinkRow>(
      `UPDATE untch_account_link_requests
          SET status = 'COMPLETED', account_id = $2, consumed_at = $3, updated_at = now(), updated_by = $4
        WHERE link_request_id = $1 AND status = 'PENDING'
        RETURNING *`,
      [args.linkRequestId, args.accountId, new Date(args.nowMs).toISOString(), args.by],
    );
    const done = completed.rows[0];
    if (!done) return { ok: false, reason: "ALREADY_COMPLETED" };
    return { ok: true, request: toRequest(done) };
  }

  async redeemVerified(args: {
    readonly linkRequestId: string;
    readonly accountId: string;
    readonly nowMs: number;
    readonly by: string;
  }): Promise<RedeemOutcome> {
    const nowIso = new Date(args.nowMs).toISOString();
    const { rows } = await this.pool.query<LinkRow>(
      `UPDATE untch_account_link_requests
          SET status = 'COMPLETED',
              account_id = $2,
              consumed_at = $3,
              agent_stage = NULL,
              updated_at = now(),
              updated_by = $4
        WHERE link_request_id = $1
          AND link_kind = 'agentic'
          AND status = 'PENDING'
          AND expires_at > $3
        RETURNING *`,
      [args.linkRequestId, args.accountId, nowIso, args.by],
    );
    if (rows[0]) return { ok: true, request: toRequest(rows[0]) };

    // Nothing was updated. Say WHICH of the three reasons it was, because "already used", "expired"
    // and "no such request" are different things to tell a user and only one of them is worth retrying.
    const current = await this.get(args.linkRequestId);
    if (!current) return { ok: false, reason: "NOT_FOUND" };
    if (current.linkKind !== "agentic") return { ok: false, reason: "NOT_FOUND" };
    if (current.status === "COMPLETED") return { ok: false, reason: "ALREADY_COMPLETED" };
    if (current.status === "CANCELLED") return { ok: false, reason: "CANCELLED" };
    return { ok: false, reason: "EXPIRED" };
  }

  async cancel(args: { readonly linkRequestId: string; readonly by: string }): Promise<void> {
    await this.pool.query(
      `UPDATE untch_account_link_requests
          SET status = 'CANCELLED', updated_at = now(), updated_by = $2
        WHERE link_request_id = $1 AND status = 'PENDING'`,
      [args.linkRequestId, args.by],
    );
  }

  async expire(nowMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE untch_account_link_requests
          SET status = 'EXPIRED', updated_at = now(), updated_by = 'sweeper'
        WHERE status = 'PENDING' AND expires_at <= $1`,
      [new Date(nowMs).toISOString()],
    );
    return rowCount ?? 0;
  }
}
