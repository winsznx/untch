/**
 * The ONE operator credential check.
 *
 * `/internal/deployment-info` already had this logic inline, and it was correct: a sha256-of-both-
 * sides `timingSafeEqual`, which is constant-time and does not leak length the way a bare
 * `timingSafeEqual` would (it throws on unequal lengths, and catching that throw is itself a length
 * oracle). It moved here unchanged, because the alternative — a second operator-auth implementation
 * next to the first — is how two credential checks end up disagreeing about what counts as valid.
 *
 * What is NEW here, and why:
 *
 *   • A FAILURE AUDIT. A wrong token on a route that can create a spending intent is an event an
 *     operator must be able to see afterwards. It records the route, the reason and a truncated
 *     digest of what was presented — never the presented value, and never the expected one.
 *   • A FAILURE THROTTLE. Not a rate limiter for load; a brake on online guessing. The token is a
 *     high-entropy secret, so this is defence in depth rather than the control — but a route that
 *     admits unlimited attempts at a shared secret should not be the newest thing in the service.
 *   • A STABLE OPERATOR KEY IDENTIFIER. `sha256(token)` truncated, so an intent created through an
 *     operator route can name WHICH credential created it without the record containing the
 *     credential. Rotating the token changes the identifier, which is the property that makes it
 *     worth storing.
 *
 * Nothing in this module ever logs, returns, echoes or stores the token itself. The two digests it
 * does produce are one-way and truncated, and neither is accepted as an input anywhere.
 */

import type { Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

/** How many consecutive failures from one source before it is refused outright. */
export const OPS_AUTH_FAILURE_LIMIT = 10;
/** How long a source stays locked out after crossing the limit. */
export const OPS_AUTH_LOCKOUT_MS = 60_000;

export type OperatorAuthOutcome =
  | { readonly ok: true; readonly operatorKeyId: string }
  | {
      readonly ok: false;
      readonly status: 401 | 429 | 503;
      readonly code: "OPS_AUTH_NOT_CONFIGURED" | "OPS_AUTH_REQUIRED" | "OPS_AUTH_THROTTLED";
      readonly message: string;
    };

export interface OperatorAuthAudit {
  readonly at: string;
  readonly route: string;
  readonly outcome: "ACCEPTED" | "REFUSED" | "THROTTLED" | "UNCONFIGURED";
  /** Truncated sha256 of the PRESENTED value, or null when nothing was presented. Never reversible. */
  readonly presentedKeyId: string | null;
  readonly source: string;
}

/**
 * Constant-time comparison that does not leak length.
 *
 * Comparing fixed-width digests of both sides removes the length difference that makes
 * `timingSafeEqual` throw, so the comparison is uniform for every input shape.
 */
export function operatorTokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * A one-way, truncated identifier for a credential.
 *
 * 16 hex characters of a sha256. Long enough that two live operator tokens will not collide, short
 * enough that it is obviously not a key, and one-way in either case.
 */
export function operatorKeyId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function presentedOperatorToken(req: Request): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
  if (bearer) return bearer.trim();
  const header = req.header("x-untch-ops-token");
  return header ? header.trim() : null;
}

/**
 * The failure brake.
 *
 * In-process and deliberately so. A durable counter would need a store, and this instance is not the
 * control that stops a determined attacker — the token's entropy is. What this stops is an
 * unattended script hammering a production route, and for that a per-container counter is enough.
 */
class FailureThrottle {
  private readonly failures = new Map<string, { count: number; until: number }>();

  lockedOut(source: string, now: number): boolean {
    const seen = this.failures.get(source);
    if (!seen) return false;
    if (now >= seen.until) {
      this.failures.delete(source);
      return false;
    }
    return seen.count >= OPS_AUTH_FAILURE_LIMIT;
  }

  recordFailure(source: string, now: number): void {
    const seen = this.failures.get(source);
    const count = seen && now < seen.until ? seen.count + 1 : 1;
    this.failures.set(source, { count, until: now + OPS_AUTH_LOCKOUT_MS });
  }

  clear(source: string): void {
    this.failures.delete(source);
  }

  reset(): void {
    this.failures.clear();
  }
}

const throttle = new FailureThrottle();

/** Test-only reset. Exported rather than reached into, so the field itself stays private. */
export function resetOperatorAuthThrottle(): void {
  throttle.reset();
}

/**
 * The audit ring.
 *
 * Bounded so a flood of failures cannot become a memory problem, and readable through
 * `recentOperatorAuthEvents` so a test can assert what was recorded — specifically, that the token
 * is not in it.
 */
const AUDIT_CAPACITY = 200;
const auditLog: OperatorAuthAudit[] = [];

function audit(entry: OperatorAuthAudit): void {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_CAPACITY) auditLog.splice(0, auditLog.length - AUDIT_CAPACITY);
}

export function recentOperatorAuthEvents(): readonly OperatorAuthAudit[] {
  return [...auditLog];
}

export function resetOperatorAuthAudit(): void {
  auditLog.length = 0;
}

/**
 * Authenticate an operator request.
 *
 * Fails CLOSED in every direction: an unconfigured instance is unavailable rather than public, an
 * absent token is a refusal rather than a default identity, and a locked-out source is refused
 * before the comparison runs.
 */
export function authenticateOperator(
  req: Request,
  opts: { readonly route: string; readonly now?: number; readonly env?: NodeJS.ProcessEnv } = {
    route: "(unnamed)",
  },
): OperatorAuthOutcome {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const source = req.ip ?? req.socket?.remoteAddress ?? "(unknown)";
  const presented = presentedOperatorToken(req);
  const presentedKeyId = presented === null ? null : operatorKeyId(presented);

  const expected = env.INTERNAL_OPS_TOKEN?.trim();
  if (!expected) {
    audit({ at: new Date(now).toISOString(), route: opts.route, outcome: "UNCONFIGURED", presentedKeyId, source });
    return {
      ok: false,
      status: 503,
      code: "OPS_AUTH_NOT_CONFIGURED",
      message: "INTERNAL_OPS_TOKEN is unset on this instance, so operator routes are unavailable",
    };
  }

  if (throttle.lockedOut(source, now)) {
    audit({ at: new Date(now).toISOString(), route: opts.route, outcome: "THROTTLED", presentedKeyId, source });
    return {
      ok: false,
      status: 429,
      code: "OPS_AUTH_THROTTLED",
      message: "too many failed operator authentications from this source — wait and retry",
    };
  }

  if (!presented || !operatorTokenMatches(presented, expected)) {
    throttle.recordFailure(source, now);
    audit({ at: new Date(now).toISOString(), route: opts.route, outcome: "REFUSED", presentedKeyId, source });
    return {
      ok: false,
      status: 401,
      code: "OPS_AUTH_REQUIRED",
      message: "send the operator token as `Authorization: Bearer <token>`",
    };
  }

  throttle.clear(source);
  const keyId = operatorKeyId(presented);
  audit({ at: new Date(now).toISOString(), route: opts.route, outcome: "ACCEPTED", presentedKeyId: keyId, source });
  return { ok: true, operatorKeyId: keyId };
}
