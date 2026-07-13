/**
 * @untch/x402-guard — public types.
 *
 * The package is deliberately zero-dependency: addresses, token addresses and hashes are plain
 * `string`s (0x-hex), normalized internally, so it drops into any runtime (Node, Deno, Bun, edge)
 * without pulling a chain SDK. Bring your own signer.
 */

/** A lowercase-normalized 0x address or 0x-hex hash. Kept as `string` so the package has no SDK dep. */
export type HexString = string;

/**
 * The twelve fields that bind a payment to the exact context it was authorized for — the
 * Challenge Binding Check surface (PRD §14). Every field is compared EXACTLY (after deterministic
 * normalization) between what the caller authorized and what the 402 challenge actually presents.
 *
 * The first eight are always present. `taskHash`/`intentHash`/`policyId`/`metadataHash` are optional
 * because not every flow carries them — but when present on EITHER side, both sides must carry the
 * same value (a field present on one side and absent on the other is itself a binding mismatch;
 * silently injected or dropped context is exactly the attack this primitive exists to catch).
 */
export interface ChallengeBinding {
  /** Payment recipient (x402 `payTo`). Address; compared case-insensitively. */
  readonly recipient: HexString;
  /** Settlement token (x402 `asset`). Address; compared case-insensitively. */
  readonly token: HexString;
  /** Amount in atomic base units, as an exact decimal string. Never a float. */
  readonly amount: string;
  /** The resource URL the payment buys (x402 `resource.url`). */
  readonly resourceUrl: string;
  /** The HTTP endpoint actually invoked by the caller. Usually equals `resourceUrl`. */
  readonly endpoint: string;
  /** HTTP method actually invoked; compared case-insensitively. */
  readonly method: string;
  /** Payment / authorization nonce. Mismatch ⇒ replay. */
  readonly nonce: string;
  /** Authorization expiry (unix seconds, decimal string). Mismatch ⇒ replay / stale-sig window. */
  readonly expiry: string;
  /** Optional §8.1 task binding. */
  readonly taskHash?: HexString;
  /** Optional §8.1 intent hash binding. */
  readonly intentHash?: HexString;
  /** Optional policy id the spend committed to (uint256 decimal string). */
  readonly policyId?: string;
  /** Optional hash of the (redacted) payment metadata. */
  readonly metadataHash?: string;
}

/** Every field of a `ChallengeBinding` the check can flag. */
export type BindingField =
  | "recipient"
  | "token"
  | "amount"
  | "resourceUrl"
  | "endpoint"
  | "method"
  | "nonce"
  | "expiry"
  | "taskHash"
  | "intentHash"
  | "policyId"
  | "metadataHash";

/**
 * Terminal binding-failure codes (PRD §14 / §7.1).
 *   • `BLOCKED_REPLAY`    — a replay signature: the nonce or expiry diverged from what was authorized.
 *   • `REJECTED_BINDING`  — a context-swap: recipient / token / amount / resource / endpoint / method
 *                           or a bound hash diverged.
 * Both are terminal: the caller's signer is NEVER invoked.
 */
export type BindingFailureCode = "BLOCKED_REPLAY" | "REJECTED_BINDING";

export type BindingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: BindingFailureCode;
      readonly field: BindingField;
      readonly expected: string | null;
      readonly presented: string | null;
      readonly detail: string;
    };

/**
 * The parsed content of an x402 `PAYMENT-REQUIRED` (402) challenge — the fields the guard extracts
 * from the seller's challenge to build the PRESENTED binding.
 */
export interface ParsedChallenge {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly recipient: HexString;
  readonly token: HexString;
  readonly amount: string;
  readonly resourceUrl: string;
  readonly maxTimeoutSeconds: number | null;
  /** Anything the seller attached in `accepts[].extra` — where optional bound fields may live. */
  readonly extra: Record<string, unknown>;
}

/**
 * The decision returned by a `preflight_payment` (PRD §11) call. Only `decision` is required — the
 * guard maps its prefix to APPROVE / BLOCK / ESCALATE and never reinterprets the reasons/trace.
 */
export interface PreflightDecision {
  readonly decision: string;
  readonly reasons?: readonly string[];
  readonly ruleTrace?: unknown;
  readonly intentHash?: HexString;
  readonly policyId?: string;
  readonly policyVersion?: number | string;
  readonly receiptRef?: { readonly receiptId: HexString; readonly status: string } | null;
  readonly [key: string]: unknown;
}

/** A non-blocking handle the caller can poll to resolve an ESCALATED decision on its own schedule. */
export interface PollHandle {
  /** Stable id of the held decision — the receiptId when preflight returned one, else a local id. */
  readonly id: string;
  /** The escalation outcome code from preflight (e.g. `ESCALATED_THRESHOLD`). */
  readonly reason: string;
  /** When the hold was created (unix ms). */
  readonly heldAt: number;
  /**
   * Resolve the current state WITHOUT blocking on a human. The guard performs no waiting itself; the
   * caller decides its own poll cadence. Absent a resolver, returns the held state unchanged.
   */
  poll(): Promise<EscalationState>;
}

export type EscalationState =
  | { readonly status: "PENDING"; readonly reason: string }
  | { readonly status: "APPROVED"; readonly decision: PreflightDecision }
  | { readonly status: "DENIED"; readonly reason: string };

/** The three-way outcome of a guarded paid call. */
export type GuardOutcome =
  | {
      readonly status: "APPROVED";
      /** The settled response returned by the caller's OWN signer. */
      readonly response: unknown;
      readonly decision: PreflightDecision;
      readonly binding: ChallengeBinding;
    }
  | {
      readonly status: "BLOCKED";
      readonly code: string;
      readonly detail: string;
      readonly decision?: PreflightDecision;
      readonly binding?: BindingResult;
    }
  | {
      readonly status: "ESCALATED";
      readonly pollHandle: PollHandle;
      readonly decision: PreflightDecision;
    };

/**
 * The caller's OWN signer — dependency-injected. The guard NEVER holds, sees, or requests a private
 * key; it decides only WHETHER this callback may run. On APPROVE the guard calls it exactly once to
 * perform the EIP-3009 sign + paid retry and returns whatever it returns as the settled response.
 */
export type SignAndPay = (ctx: SignAndPayContext) => Promise<unknown>;

export interface SignAndPayContext {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  /** The exact challenge the guard validated — the signer pays THIS, nothing re-fetched. */
  readonly challenge: ParsedChallenge;
  /** The binding the guard confirmed. */
  readonly binding: ChallengeBinding;
}

/** Injected preflight caller (PRD §11 `preflight_payment`). How it pays for itself is the caller's concern. */
export type PreflightFn = (input: PreflightInput) => Promise<PreflightDecision>;

export interface PreflightInput {
  readonly binding: ChallengeBinding;
  readonly challenge: ParsedChallenge;
}

/** Optional resolver for an escalation's `poll()` — e.g. a call to the escalation service (§7.2). */
export type EscalationResolver = (handle: {
  readonly id: string;
  readonly reason: string;
}) => Promise<EscalationState>;

export interface GuardDeps {
  /** DI: reach `preflight_payment`. Required. */
  readonly preflight: PreflightFn;
  /** DI: the caller's own signer. Required. The guard never signs. */
  readonly signAndPay: SignAndPay;
  /** DI: fetch used for the initial unpaid 402 probe. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** DI: clock (unix ms). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** DI: how an ESCALATED hold is later resolved when polled. Optional (default: stays PENDING). */
  readonly escalationResolver?: EscalationResolver;
}

export interface GuardRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  /**
   * The binding the caller AUTHORIZED — the source of truth the presented 402 challenge is checked
   * against. Build it with `bindingFromIntent`, or by hand.
   */
  readonly expectedBinding: ChallengeBinding;
}
