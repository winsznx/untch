/**
 * Identifiers and idempotency keys.
 *
 * Two properties matter:
 *
 *   1. An idempotency key is derived from the REQUEST, not supplied by it, whenever the caller does
 *      not supply one. A caller that forgets the header still gets duplicate protection.
 *   2. Every idempotency scope is prefixed with the tenant. `idempotency_records` is keyed
 *      `PRIMARY KEY (tenant_id, key)` in SQL, and the derivation folds the tenant in as well, so a
 *      cross-tenant collision is impossible at both layers rather than at one.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ConsumerIntentId = string;

export function newIntentId(rand: () => Buffer = () => randomBytes(12)): ConsumerIntentId {
  return `ci_${rand().toString("hex")}`;
}

export function newQuoteId(rand: () => Buffer = () => randomBytes(9)): string {
  return `cq_${rand().toString("hex")}`;
}

export function newDiscoveryId(rand: () => Buffer = () => randomBytes(9)): string {
  return `cd_${rand().toString("hex")}`;
}

export function newCapabilityId(rand: () => Buffer = () => randomBytes(12)): string {
  return `cap_${rand().toString("hex")}`;
}

export function newCorrelationId(rand: () => Buffer = () => randomBytes(8)): string {
  return `cor_${rand().toString("hex")}`;
}

export function isIntentId(v: unknown): v is ConsumerIntentId {
  return typeof v === "string" && /^ci_[0-9a-f]{24}$/.test(v);
}

/**
 * Deterministic, stable stringification for hashing. Object keys are sorted; `undefined` members are
 * dropped; bigints render as decimal strings. This is intentionally NOT @untch/canon's RFC 8785
 * canonicalizer: canon's output is consensus-critical (it feeds the on-chain intentHash) and must not
 * grow a second caller with different inputs. This one hashes off-chain request/quote shapes only.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const member = src[key];
      if (member === undefined) continue;
      out[key] = normalize(member);
    }
    return out;
  }
  return v;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The quote hash. This is the value an approval binds to, and the value execution re-checks. Any
 * change to what was quoted — price, provider, recipient, asset, terms — produces a different hash
 * and therefore invalidates the approval, which is exactly the "quote tampering" control.
 */
export function hashQuote(canonicalQuote: unknown): string {
  return `0x${sha256Hex(stableStringify(canonicalQuote))}`;
}

/**
 * Derive an idempotency key for a request. `tenantId` is folded in so two tenants issuing byte-identical
 * requests never collide, and a `salt` (the action type) keeps a search and a purchase with the same
 * parameters distinct.
 */
export function deriveIdempotencyKey(args: {
  readonly tenantId: string;
  readonly action: string;
  readonly request: unknown;
}): string {
  return sha256Hex(
    stableStringify({ t: args.tenantId, a: args.action, r: args.request }),
  ).slice(0, 48);
}

/** Normalize a caller-supplied idempotency key, still scoped by tenant at the storage layer. */
export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 8 || t.length > 200) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(t)) return null;
  return t;
}

/**
 * The provider-facing idempotency key. Providers that support one (Purch's `client_request_id`,
 * StableMerch's `client_request_id`) get a value derived from the INTENT, so a worker retry of the
 * same intent presents the same key while two distinct intents never can.
 */
export function providerIdempotencyKey(intentId: string, attemptScope = "exec"): string {
  return `untch-${attemptScope}-${sha256Hex(`${intentId}|${attemptScope}`).slice(0, 32)}`;
}

/** Constant-time comparison for webhook signatures and approval codes. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
