/**
 * What a marketplace caller sends, as opposed to what the protocol needs.
 *
 * WHY THESE EXIST
 *
 * `preflight_payment` demanded seventeen fields. Ten of them were not facts about the caller's
 * request at all — they were protocol material: a policy hash the caller had no route to read, an
 * owner address that is a property of the policy rather than of the request, a token address that is
 * a property of the network, hashes of things the caller had already described in plain text, and a
 * nonce whose only job is to make two identical requests distinguishable. Asking a stranger's agent
 * for those is asking it to reconstruct this service's internals before it may use the service.
 *
 * `verify_delivery` was worse: it demanded the same seventeen again, plus the acceptance criteria
 * that had been committed when the work started — a value the caller could not have kept, because
 * nothing ever returned it.
 *
 * THE SHAPE OF THE FIX
 *
 * A caller states its own request in its own terms: who it wants to buy from, what it wants done,
 * the most it will spend, in what currency, by when. Everything derivable from production state is
 * derived from production state — see `mapping.ts`, which also refuses rather than substituting a
 * value it cannot honestly derive.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No `policyHash`, no `owner`, no `token`, no `taskHash`/`acceptanceHash`/`schemaHash`/`paramsHash`,
 * no `nonce`, no `endpoint`. Each is derived. A caller that could supply them could also supply a
 * wrong one, and a policy binding a caller can choose is not a binding.
 */

/** Which policy judges this request. Exactly one of the two forms. */
export interface PolicySelection {
  /** A specific registered policy. */
  readonly policyId?: string;
  /**
   * Use whichever policy this account has marked as its default.
   *
   * Explicit rather than implied by omission. A request that silently fell back to a default policy
   * would be a request whose spending limits nobody chose for it.
   */
  readonly useDefaultPolicy?: boolean;
}

export interface PublicPreflightRequest extends PolicySelection {
  /** The provider that will be paid, by its registered id. */
  readonly provider: string;
  /** What the provider is being asked to do, by its registered capability id. */
  readonly capability: string;
  /** What this payment is for, in a sentence a person would recognise. */
  readonly task: string;
  /** The ceiling, in display units of `currency` — "20.00", not base units. */
  readonly maxSpend: string;
  /** The settlement currency's symbol, e.g. "USDT0". */
  readonly currency: string;
  /** ISO 8601. After this the request is stale and must be rebuilt rather than replayed. */
  readonly deadline: string;

  /** Optional. Constrains who may be paid. Absent means the recipient is resolved from the provider. */
  readonly recipient?: string;
  /** Optional. The structured parameters that will be sent to the provider. */
  readonly parameters?: Record<string, unknown>;
  /** Optional. What "delivered" will mean, committed now so verification has something to compare to. */
  readonly acceptance?: Record<string, unknown>;
  /**
   * Optional. Makes a retry of an identical request produce the same intent rather than a second one.
   *
   * Also what the derived nonce is built from, so idempotency is a property of the request rather than
   * of a counter the caller cannot see.
   */
  readonly idempotencyKey?: string;

  /**
   * Optional, and temporary.
   *
   * These are properties of an ACCOUNT, not of a request, and once a wallet is bound to an Untch
   * account they are derived from that binding and ignored here. Until then a caller that already
   * holds an ERC-8004 id can supply it rather than being unable to proceed — and a caller that does
   * not is told exactly what is missing instead of having a zero substituted for it.
   */
  readonly buyerAgentId?: string;
  readonly workerAgentId?: string;
}

/**
 * Verification, reduced to the one thing only the caller knows.
 *
 * Everything else — which policy, what was quoted, what executed, what settled, what came back, and
 * which receipt covers it — is evidence this service already holds against that intent. Asking the
 * caller to resend it was asking them to prove a claim using material this service is the custodian
 * of, and the acceptance criteria in particular were never returned to them in the first place.
 */
export interface PublicVerifyRequest {
  /** The intent to verify. */
  readonly intentId: string;
  /**
   * Optional. A hash the caller believes the result should have.
   *
   * When present it is compared and the comparison is reported. It never overrides the committed
   * acceptance criteria — a buyer asserting what the answer should be is not the same as the answer
   * being what was agreed.
   */
  readonly expectedResultHash?: string;
}

/** One thing the server could not derive, and what would make it derivable. */
export interface MissingAuthority {
  /** The internal protocol field that has no honest value. */
  readonly field: string;
  /** Why it cannot be guessed. */
  readonly why: string;
  /** What would supply it. */
  readonly resolvedFrom: string;
}

/** Everything the server derived, and what it derived each value from. */
export interface DerivationRecord {
  readonly field: string;
  readonly value: string;
  readonly derivedFrom: string;
}
