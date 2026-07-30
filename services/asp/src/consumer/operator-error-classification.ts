/**
 * Turning a domain failure into an answer a controller can act on.
 *
 * WHY THIS EXISTS
 *
 * The first bounded production proof reached the create route, hit a real provider defect, and got back
 * express's default HTML error page with HTTP 500. That is the worst possible answer to "did my intent
 * get created?": it is unparseable, it names no cause, it says nothing about whether an intent now exists,
 * and it invites a retry that could be the second authorisation.
 *
 * The concurrency case was already classified — a lost race returns a named 409 — but everything else fell
 * through to the default handler. A `ProviderError` is a DOMAIN outcome, not a crash: the provider was
 * asked something and answered, or failed to. It deserves the same treatment.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No stack traces, no provider bodies, no payment challenges, no SQL. The provider's own text has already
 * been truncated and sanitized by `normalizedError` at the adapter boundary; this layer chooses a status
 * and a shape and adds nothing new. A controller needs to know WHAT class of thing went wrong and whether
 * anything durable exists, and neither answer requires a stack.
 */

import { isProviderError, type NormalizedProviderError, type ProviderErrorCode } from "@untch/consumer-core";

/** What a caller may do next. Distinct from `retryable`, which is the provider's own view. */
export type FailureDisposition =
  /** The request itself is wrong. Fix it and send a NEW one. */
  | "TERMINAL_NEW_REQUEST_REQUIRED"
  /** Nothing was committed and the same request may be sent again later. */
  | "RETRYABLE_SAME_REQUEST"
  /** The outcome is unknown. Never retry; a human decides. */
  | "MANUAL_REVIEW";

export interface ClassifiedFailure {
  readonly status: number;
  readonly code: ProviderErrorCode | "INTERNAL_ERROR";
  readonly message: string;
  readonly disposition: FailureDisposition;
  readonly retryable: boolean;
  /** True when a corrected request must use a fresh intent id, because this one is now terminal. */
  readonly newIntentRequired: boolean;
}

/**
 * The status each provider-error class deserves, and why.
 *
 * The mapping is about WHOSE fault it is and WHAT the caller can do, not about how bad it felt. A
 * malformed provider response is a 502 because the upstream misbehaved; a request Untch built wrongly is
 * a 400 because the caller must change something; an ambiguous outcome is a 409 because it is a conflict
 * with reality that no retry resolves.
 */
const MAP: Readonly<Record<ProviderErrorCode, { status: number; disposition: FailureDisposition }>> = {
  // The caller's request, or the request Untch built from it, is wrong.
  PROVIDER_BAD_REQUEST: { status: 400, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },
  PROVIDER_REJECTED: { status: 422, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },

  // The upstream misbehaved or is unreachable.
  PROVIDER_MALFORMED_RESPONSE: { status: 502, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },
  PROVIDER_UNAVAILABLE: { status: 503, disposition: "RETRYABLE_SAME_REQUEST" },
  PROVIDER_RATE_LIMITED: { status: 503, disposition: "RETRYABLE_SAME_REQUEST" },
  PROVIDER_UNAUTHORIZED: { status: 502, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },

  /**
   * Ambiguity is 409, and never 5xx.
   *
   * A 5xx invites a retry, and a retry is the one thing that must not happen when the provider may
   * already have acted. The status is chosen for what it discourages.
   */
  PROVIDER_AMBIGUOUS: { status: 409, disposition: "MANUAL_REVIEW" },
  PAYMENT_AMBIGUOUS: { status: 409, disposition: "MANUAL_REVIEW" },

  // Protocol and payment binding: the offer could not be satisfied from what was authorised.
  PAYMENT_CHALLENGE_UNACCEPTABLE: { status: 502, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },
  PAYMENT_BINDING_MISMATCH: { status: 409, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },
  PAYMENT_FAILED: { status: 502, disposition: "RETRYABLE_SAME_REQUEST" },
  PROTOCOL_NOT_EXECUTABLE: { status: 501, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },

  // Operational state of this deployment, not of the request.
  TREASURY_INSUFFICIENT: { status: 503, disposition: "RETRYABLE_SAME_REQUEST" },
  PAUSED: { status: 503, disposition: "RETRYABLE_SAME_REQUEST" },
  CIRCUIT_OPEN: { status: 503, disposition: "RETRYABLE_SAME_REQUEST" },
  PROVIDER_NOT_EXECUTABLE: { status: 409, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },
  CAPABILITY_UNAVAILABLE: { status: 409, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },
  QUOTE_EXPIRED: { status: 409, disposition: "TERMINAL_NEW_REQUEST_REQUIRED" },

  /**
   * Unclassified is treated as ambiguous, which is the conservative default the error taxonomy already
   * takes. An unknown failure that might have acted is indistinguishable from one that did.
   */
  PROVIDER_UNKNOWN: { status: 409, disposition: "MANUAL_REVIEW" },
};

/**
 * Classify a thrown value.
 *
 * A non-`ProviderError` is a genuine internal fault and stays a 500 — but a JSON 500, with a code, so a
 * controller can still parse it and tell "the service broke" from "the provider refused".
 */
export function classifyFailure(err: unknown): ClassifiedFailure {
  if (!isProviderError(err)) {
    return {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "an unexpected internal error occurred; nothing about the provider is implied",
      disposition: "MANUAL_REVIEW",
      retryable: false,
      newIntentRequired: true,
    };
  }
  const normalized: NormalizedProviderError = err.normalized;
  const mapped = MAP[normalized.code] ?? MAP.PROVIDER_UNKNOWN;
  return {
    status: mapped.status,
    code: normalized.code,
    // Already truncated and sanitized at the adapter boundary. Not re-wrapped: adding our own prefix
    // would push the provider's own words past the point a reader still sees them.
    message: normalized.message,
    disposition: mapped.disposition,
    retryable: normalized.retryable,
    /**
     * A terminal failure consumes the intent id.
     *
     * The id is caller-supplied and unique per authorisation, so once an intent exists and has reached a
     * terminal state, a corrected request is a DIFFERENT authorisation and needs a different id. Saying so
     * in the response is what stops an operator from reusing one and quietly re-entering the same failure.
     */
    newIntentRequired: mapped.disposition !== "RETRYABLE_SAME_REQUEST",
  };
}
