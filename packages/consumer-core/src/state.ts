/**
 * The Consumer Intent state machine.
 *
 * There is exactly ONE place a state transition is judged legal — `assertTransition` — and exactly one
 * place a state is written: `ConsumerIntentRepo.transition`, which performs a compare-and-set
 * (`UPDATE … WHERE id = $1 AND state = $2`). Controllers and provider adapters have no route to
 * `state` at all. That is deliberate: the whole point of the Consumer Pack is that authority is
 * bounded, and a lifecycle that any handler can nudge sideways is not bounded.
 *
 * The single most load-bearing property, asserted exhaustively over the whole map in
 * test/state.test.ts rather than spot-checked:
 *
 *   Once a state at or beyond PROVIDER_PAYMENT_PENDING is reached, FAILED_BEFORE_PAYMENT is
 *   UNREACHABLE. Money may have left the treasury; a lifecycle that can still claim "failed before
 *   payment" from there would let a refund be issued for a purchase that actually happened.
 *
 * Its mirror: an ambiguous provider outcome resolves to MANUAL_REVIEW, never to a retry and never to
 * a terminal success. Nothing in this map lets a machine decide an ambiguous purchase.
 */

export const CONSUMER_INTENT_STATES = [
  "CREATED",
  "DISCOVERING",
  "QUOTED",
  "POLICY_CHECKING",
  "BLOCKED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "AWAITING_FUNDING",
  "FUNDED",
  "EXECUTION_QUEUED",
  "PROVIDER_PAYMENT_PENDING",
  "PROVIDER_PAID",
  "PROVIDER_ACKNOWLEDGED",
  "DELIVERY_PENDING",
  "DELIVERY_VERIFIED",
  "COMPLETED",
  "FAILED_BEFORE_PAYMENT",
  "FAILED_AFTER_PAYMENT",
  "REFUND_PENDING",
  "REFUNDED",
  "MANUAL_REVIEW",
  "EXPIRED",
  "CANCELLED",
] as const;

export type ConsumerIntentState = (typeof CONSUMER_INTENT_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(CONSUMER_INTENT_STATES);

export function isConsumerIntentState(v: unknown): v is ConsumerIntentState {
  return typeof v === "string" && STATE_SET.has(v);
}

/**
 * States from which the treasury may already have paid a provider. Reaching any of these is the
 * irreversible commitment point: FAILED_BEFORE_PAYMENT can never be entered afterwards.
 *
 * PROVIDER_PAYMENT_PENDING is included on purpose. It means "the outbound request is in flight and
 * its outcome is unknown" — precisely the ambiguous case where assuming no money moved is the
 * dangerous assumption.
 */
export const POST_PAYMENT_STATES: ReadonlySet<ConsumerIntentState> = new Set<ConsumerIntentState>([
  "PROVIDER_PAYMENT_PENDING",
  "PROVIDER_PAID",
  "PROVIDER_ACKNOWLEDGED",
  "DELIVERY_PENDING",
  "DELIVERY_VERIFIED",
  "COMPLETED",
  "FAILED_AFTER_PAYMENT",
]);

/** No transition leaves these. */
export const TERMINAL_STATES: ReadonlySet<ConsumerIntentState> = new Set<ConsumerIntentState>([
  "COMPLETED",
  "BLOCKED",
  "REFUNDED",
  "EXPIRED",
  "CANCELLED",
]);

/**
 * MANUAL_REVIEW is deliberately NOT terminal — a human resolves it — but it is only exitable to
 * outcomes a human can legitimately choose, and never back into automated execution.
 */
const TRANSITIONS: Readonly<Record<ConsumerIntentState, readonly ConsumerIntentState[]>> =
  Object.freeze({
    CREATED: ["DISCOVERING", "QUOTED", "FAILED_BEFORE_PAYMENT", "CANCELLED", "EXPIRED"],
    DISCOVERING: ["QUOTED", "FAILED_BEFORE_PAYMENT", "CANCELLED", "EXPIRED"],
    QUOTED: ["POLICY_CHECKING", "EXPIRED", "CANCELLED", "FAILED_BEFORE_PAYMENT"],
    POLICY_CHECKING: [
      "BLOCKED",
      "AWAITING_APPROVAL",
      "APPROVED",
      "FAILED_BEFORE_PAYMENT",
      "EXPIRED",
      "CANCELLED",
    ],
    BLOCKED: [],
    AWAITING_APPROVAL: ["APPROVED", "BLOCKED", "EXPIRED", "CANCELLED", "FAILED_BEFORE_PAYMENT"],
    APPROVED: ["AWAITING_FUNDING", "EXPIRED", "CANCELLED", "FAILED_BEFORE_PAYMENT"],
    // A reorged funding receipt sends FUNDED back to AWAITING_FUNDING. That is the ONLY backward
    // edge in the map, and it is legal precisely because nothing has been spent yet.
    AWAITING_FUNDING: ["FUNDED", "EXPIRED", "CANCELLED", "FAILED_BEFORE_PAYMENT"],
    FUNDED: ["EXECUTION_QUEUED", "AWAITING_FUNDING", "FAILED_BEFORE_PAYMENT", "REFUND_PENDING", "CANCELLED"],
    EXECUTION_QUEUED: ["PROVIDER_PAYMENT_PENDING", "FAILED_BEFORE_PAYMENT", "MANUAL_REVIEW"],
    // From here on, FAILED_BEFORE_PAYMENT is gone from every successor list. Enforced by test.
    PROVIDER_PAYMENT_PENDING: ["PROVIDER_PAID", "FAILED_AFTER_PAYMENT", "MANUAL_REVIEW"],
    PROVIDER_PAID: ["PROVIDER_ACKNOWLEDGED", "FAILED_AFTER_PAYMENT", "MANUAL_REVIEW"],
    PROVIDER_ACKNOWLEDGED: ["DELIVERY_PENDING", "DELIVERY_VERIFIED", "FAILED_AFTER_PAYMENT", "MANUAL_REVIEW"],
    DELIVERY_PENDING: ["DELIVERY_VERIFIED", "FAILED_AFTER_PAYMENT", "MANUAL_REVIEW"],
    DELIVERY_VERIFIED: ["COMPLETED", "MANUAL_REVIEW"],
    COMPLETED: [],
    FAILED_BEFORE_PAYMENT: ["REFUND_PENDING", "REFUNDED", "MANUAL_REVIEW"],
    FAILED_AFTER_PAYMENT: ["MANUAL_REVIEW", "REFUND_PENDING"],
    REFUND_PENDING: ["REFUNDED", "MANUAL_REVIEW"],
    REFUNDED: [],
    // Human-resolvable only. Note the absence of EXECUTION_QUEUED / PROVIDER_PAYMENT_PENDING:
    // a human may settle the outcome, but may not re-arm the automated payment path from here.
    MANUAL_REVIEW: ["COMPLETED", "REFUND_PENDING", "REFUNDED", "FAILED_AFTER_PAYMENT", "CANCELLED"],
    EXPIRED: [],
    CANCELLED: [],
  });

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: ConsumerIntentState,
    public readonly to: ConsumerIntentState,
  ) {
    super(
      `illegal consumer-intent transition ${from} → ${to} ` +
        `(legal: ${TRANSITIONS[from].length > 0 ? TRANSITIONS[from].join(", ") : "<terminal>"})`,
    );
    this.name = "InvalidStateTransitionError";
  }
}

/** Raised when a compare-and-set finds the row is no longer in the state the caller read. */
export class StaleIntentStateError extends Error {
  constructor(
    public readonly intentId: string,
    public readonly expected: ConsumerIntentState,
  ) {
    super(
      `consumer intent ${intentId} was no longer in ${expected} when the transition was applied — ` +
        "another worker advanced it; re-read and retry",
    );
    this.name = "StaleIntentStateError";
  }
}

export function canTransition(from: ConsumerIntentState, to: ConsumerIntentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ConsumerIntentState, to: ConsumerIntentState): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError(from, to);
}

export function successorsOf(state: ConsumerIntentState): readonly ConsumerIntentState[] {
  return TRANSITIONS[state];
}

export function isTerminal(state: ConsumerIntentState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isPostPayment(state: ConsumerIntentState): boolean {
  return POST_PAYMENT_STATES.has(state);
}

/**
 * States in which an intent is still awaiting something from outside and should be swept for
 * expiry. Deliberately excludes everything from EXECUTION_QUEUED onward: once execution is armed,
 * a timeout is an operational event for the worker, never a silent expiry.
 */
export const EXPIRABLE_STATES: ReadonlySet<ConsumerIntentState> = new Set<ConsumerIntentState>([
  "CREATED",
  "DISCOVERING",
  "QUOTED",
  "POLICY_CHECKING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "AWAITING_FUNDING",
]);

/**
 * The one state an intent may be moved to when its quote or approval window lapses. Separated from
 * `EXPIRABLE_STATES` so the sweeper cannot invent a different outcome.
 */
export const EXPIRY_TARGET: ConsumerIntentState = "EXPIRED";
