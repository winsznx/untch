/**
 * The normalized error taxonomy.
 *
 * A provider adapter's `normalizeError` maps whatever the merchant threw into exactly one of these
 * codes. The orchestrator then makes its decisions off the CODE, never off a message string, because
 * the one decision that must never be made from a fuzzy signal is "may I retry a purchase?".
 *
 * Three properties matter and are carried explicitly rather than inferred:
 *
 *   • `retryable` — may the SAME request be sent again? Only ever true for errors that provably
 *     happened before the provider could act.
 *   • `sideEffectPossible` — could the provider have done something despite this error? A transport
 *     timeout on a purchase is the canonical case: retryable is false, sideEffectPossible is true,
 *     and the intent goes to MANUAL_REVIEW.
 *   • `paymentSettled` — did money definitely leave the treasury? Drives which failure state applies.
 *
 * `retryable && sideEffectPossible` is a contradiction and is rejected at construction: if a side
 * effect might have occurred, resending is not a retry, it is a possible double purchase.
 */

export type ProviderErrorCode =
  /** Untch built a request the provider rejected as malformed. Our bug; never retry unchanged. */
  | "PROVIDER_BAD_REQUEST"
  /** Provider refused on the merits (out of stock, domain taken, unsupported route). Terminal. */
  | "PROVIDER_REJECTED"
  /** Provider is up but declined this caller (SIWX missing/invalid, quota). Terminal until fixed. */
  | "PROVIDER_UNAUTHORIZED"
  /** Rate limited. Safe to retry after a delay — the provider explicitly did not act. */
  | "PROVIDER_RATE_LIMITED"
  /** 5xx or connection refused BEFORE the request could be processed. Safe to retry. */
  | "PROVIDER_UNAVAILABLE"
  /** Timed out / connection dropped with the outcome UNKNOWN. Never retry. Manual review. */
  | "PROVIDER_AMBIGUOUS"
  /** Response did not match the runtime schema. Untrusted output; do not act on it. */
  | "PROVIDER_MALFORMED_RESPONSE"
  /** The 402/MPP challenge could not be satisfied from the allowlist (wrong chain/token/recipient). */
  | "PAYMENT_CHALLENGE_UNACCEPTABLE"
  /** The challenge diverged from what was authorized (x402-guard binding failure). */
  | "PAYMENT_BINDING_MISMATCH"
  /** Payment was attempted and the rail reported failure. No settlement occurred. */
  | "PAYMENT_FAILED"
  /** Payment was submitted and its settlement is unknown. Never retry. Manual review. */
  | "PAYMENT_AMBIGUOUS"
  /** The rail exists in code but is not executable in this build (MPP/Tempo today). */
  | "PROTOCOL_NOT_EXECUTABLE"
  /** The treasury float cannot cover the payment. Operational; alert and pause. */
  | "TREASURY_INSUFFICIENT"
  /** A kill switch is engaged (global / provider / chain / asset / account). */
  | "PAUSED"
  /** The provider's maturity is below what the route requires. */
  | "PROVIDER_NOT_EXECUTABLE"
  /** The quote's TTL lapsed before execution. */
  | "QUOTE_EXPIRED"
  /** A capability the route needs is not declared by any enabled provider. */
  | "CAPABILITY_UNAVAILABLE"
  /** Circuit breaker open for this provider. */
  | "CIRCUIT_OPEN"
  /** Anything genuinely unclassified. Treated as ambiguous — the conservative default. */
  | "PROVIDER_UNKNOWN";

export interface NormalizedProviderError {
  readonly code: ProviderErrorCode;
  /** Safe, non-sensitive summary. Provider text is truncated and never interpolated as instruction. */
  readonly message: string;
  readonly retryable: boolean;
  /** Could the provider have acted despite this error? */
  readonly sideEffectPossible: boolean;
  /** Did value definitely leave the treasury? */
  readonly paymentSettled: boolean;
  /** Provider HTTP status when there was one. */
  readonly httpStatus: number | null;
  /** Provider's own error identifier, when it gave one. Data, never trusted. */
  readonly providerCode: string | null;
  /** Suggested delay before a retry, when `retryable`. */
  readonly retryAfterMs: number | null;
}

const DEFAULTS: Readonly<
  Record<ProviderErrorCode, { retryable: boolean; sideEffectPossible: boolean; paymentSettled: boolean }>
> = Object.freeze({
  PROVIDER_BAD_REQUEST: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_REJECTED: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_UNAUTHORIZED: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_RATE_LIMITED: { retryable: true, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_UNAVAILABLE: { retryable: true, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_AMBIGUOUS: { retryable: false, sideEffectPossible: true, paymentSettled: false },
  PROVIDER_MALFORMED_RESPONSE: { retryable: false, sideEffectPossible: true, paymentSettled: false },
  PAYMENT_CHALLENGE_UNACCEPTABLE: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PAYMENT_BINDING_MISMATCH: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PAYMENT_FAILED: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PAYMENT_AMBIGUOUS: { retryable: false, sideEffectPossible: true, paymentSettled: false },
  PROTOCOL_NOT_EXECUTABLE: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  TREASURY_INSUFFICIENT: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PAUSED: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_NOT_EXECUTABLE: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  QUOTE_EXPIRED: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  CAPABILITY_UNAVAILABLE: { retryable: false, sideEffectPossible: false, paymentSettled: false },
  CIRCUIT_OPEN: { retryable: true, sideEffectPossible: false, paymentSettled: false },
  PROVIDER_UNKNOWN: { retryable: false, sideEffectPossible: true, paymentSettled: false },
});

/** Provider text is data. Truncate hard, strip control characters, never let it reach a log verbatim. */
export function sanitizeProviderText(raw: unknown, max = 200): string {
  if (typeof raw !== "string") return "";
  // Strip C0/C1 controls (log injection / ANSI escapes) without a control-char regex class.
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function normalizedError(
  code: ProviderErrorCode,
  message: string,
  overrides: {
    readonly retryable?: boolean;
    readonly sideEffectPossible?: boolean;
    readonly paymentSettled?: boolean;
    readonly httpStatus?: number | null;
    readonly providerCode?: string | null;
    readonly retryAfterMs?: number | null;
  } = {},
): NormalizedProviderError {
  const base = DEFAULTS[code];
  const retryable = overrides.retryable ?? base.retryable;
  const sideEffectPossible = overrides.sideEffectPossible ?? base.sideEffectPossible;
  if (retryable && sideEffectPossible) {
    throw new Error(
      `refusing to build a normalized error that is both retryable and side-effect-possible (${code}): ` +
        "resending a request that may already have purchased something is a double purchase, not a retry",
    );
  }
  return {
    code,
    message: sanitizeProviderText(message, 300),
    retryable,
    sideEffectPossible,
    paymentSettled: overrides.paymentSettled ?? base.paymentSettled,
    httpStatus: overrides.httpStatus ?? null,
    providerCode: overrides.providerCode === undefined ? null : overrides.providerCode,
    retryAfterMs: overrides.retryAfterMs ?? null,
  };
}

/** An error carrying a normalized classification, so it survives a throw/catch boundary intact. */
export class ProviderError extends Error {
  constructor(public readonly normalized: NormalizedProviderError) {
    super(`${normalized.code}: ${normalized.message}`);
    this.name = "ProviderError";
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/**
 * The fallback classification for anything that escaped an adapter unnormalized. It is deliberately
 * the most conservative row in the table — unknown means "assume the provider may have acted".
 */
export function unknownProviderError(e: unknown): NormalizedProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  return normalizedError("PROVIDER_UNKNOWN", sanitizeProviderText(msg));
}

/** The §11 error envelope the ASP already uses, so consumer routes answer in the house shape. */
export interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly docsUrl: string | null;
}

export function toErrorEnvelope(e: NormalizedProviderError): ErrorEnvelope {
  return { code: e.code, message: e.message, retryable: e.retryable, docsUrl: null };
}
