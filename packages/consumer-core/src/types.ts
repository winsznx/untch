/**
 * Consumer Pack domain types.
 *
 * Naming and nesting deliberately echo the existing §8 data model so the two halves of the system
 * read as one: a Consumer Intent is the long-running sibling of a §8.1 SpendIntent, not a rival
 * concept. Where a Consumer Intent carries something §8 has no equivalent for — a provider
 * settlement on another chain, a delivery evidence bundle, a funding receipt — the new field is
 * named for what it is rather than bent to fit an existing column.
 */

import type { AssetRef, CaipChainId } from "./assets";
import type { Money, MoneyJson } from "./money";
import type { ConsumerIntentState } from "./state";
import type { NormalizedProviderError } from "./errors";

/** The consumer categories the pack governs. Adding one is a deliberate, typed change. */
export type ConsumerCategory = "shop" | "domains" | "travel" | "gifts" | "notify" | "mail" | "data";

/**
 * The verbs a category can express. `ActionType` is what the policy engine sees as the intent's
 * `category` string (prefixed), so a policy can allow `domains.check` while denying `domains.register`.
 */
export type ConsumerActionType =
  | "shop.search"
  | "shop.detail"
  | "shop.quote"
  | "shop.purchase"
  | "shop.track"
  | "domains.check"
  | "domains.quote"
  | "domains.register"
  | "domains.renew"
  | "domains.dns"
  | "travel.search"
  | "travel.compare"
  | "travel.quote"
  | "travel.book"
  | "travel.cancel"
  | "gifts.quote"
  | "gifts.order"
  | "gifts.track"
  | "notify.confirmation"
  | "notify.receipt"
  | "notify.exception"
  // Untch Mail. Separate from `notify.*` on purpose: `notify.*` is Untch sending its OWN
  // operational mail about an intent, `mail.*` is a consumer buying an email action as the
  // product. They share a provider and share nothing else — a policy that permits Untch to send
  // a receipt notification must not thereby permit a caller to buy a $5 subdomain.
  | "mail.send"
  | "mail.inbox.buy"
  | "mail.inbox.status"
  // Reading an inbox Untch owns. This is what turns `mail.send` from a hand-off into a round trip:
  // delivery to an Untch-owned inbox can be checked, delivery to the open internet cannot.
  | "mail.inbox.messages"
  | "mail.inbox.topup"
  | "mail.inbox.cancel"
  | "mail.subdomain.buy"
  | "mail.subdomain.status"
  | "mail.subdomain.send";

/**
 * The same union, at runtime.
 *
 * A route that takes a capability name off the wire has to narrow a `string` into a
 * `ConsumerActionType`, and the only alternatives to a runtime list are a cast — which would let any
 * string through and fail somewhere further in — or a hand-written type guard that can silently fall
 * behind the union. `satisfies` binds the two together: adding a member to the union without adding
 * it here is a compile error, and so is a typo in this list.
 */
export const CONSUMER_ACTION_TYPES = [
  "shop.search",
  "shop.detail",
  "shop.quote",
  "shop.purchase",
  "shop.track",
  "domains.check",
  "domains.quote",
  "domains.register",
  "domains.renew",
  "domains.dns",
  "travel.search",
  "travel.compare",
  "travel.quote",
  "travel.book",
  "travel.cancel",
  "gifts.quote",
  "gifts.order",
  "gifts.track",
  "notify.confirmation",
  "notify.receipt",
  "notify.exception",
  "mail.send",
  "mail.inbox.buy",
  "mail.inbox.status",
  "mail.inbox.messages",
  "mail.inbox.topup",
  "mail.inbox.cancel",
  "mail.subdomain.buy",
  "mail.subdomain.status",
  "mail.subdomain.send",
] as const satisfies readonly ConsumerActionType[];

const ACTION_TYPE_SET: ReadonlySet<string> = new Set<string>(CONSUMER_ACTION_TYPES);

export function isConsumerActionType(value: unknown): value is ConsumerActionType {
  return typeof value === "string" && ACTION_TYPE_SET.has(value);
}

/** Whether an action can move value, and therefore whether it needs the full funding lifecycle. */
export const VALUE_MOVING_ACTIONS: ReadonlySet<ConsumerActionType> = new Set<ConsumerActionType>([
  "shop.purchase",
  "domains.register",
  "domains.renew",
  "travel.book",
  "gifts.order",
  // The Mail purchases that are worth funding rather than absorbing. A $1 inbox and a $5 subdomain
  // are real user-funded buys and get the funding TTL; `mail.send` and `mail.subdomain.send` are
  // cents-scale and sit on the quote TTL alongside `notify.*`, which they share an endpoint with.
  "mail.inbox.buy",
  "mail.inbox.topup",
  "mail.subdomain.buy",
]);

/** The policy-engine `category` slug for an action. Kept in one function so it can never drift. */
export function policyCategoryFor(action: ConsumerActionType): string {
  return `consumer.${action}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A provider's exact, time-bounded offer. Immutable: a re-quote produces a NEW row with a new
 * `quoteHash`, never an update, because an approval is bound to a hash and a mutable quote would
 * silently re-scope an approval that a human already gave.
 */
export interface ConsumerQuote {
  readonly quoteId: string;
  readonly intentId: string;
  readonly providerId: string;
  /** What the provider will charge, in the provider's OWN settlement asset. */
  readonly providerCost: Money;
  /** Untch's orchestration fee for this action, in the user's funding asset. */
  readonly untchFee: Money;
  /**
   * The spread Untch takes to absorb cross-rail price movement between funding and settlement.
   * Always non-negative and always disclosed; zero is a legitimate value and is shown as zero.
   */
  readonly spread: Money;
  /** The exact total the user is asked to fund, in the funding asset. */
  readonly totalUserAmount: Money;
  /** The ceiling the approval authorises. `providerCost` may never exceed this at execution time. */
  readonly maxAuthorisedAmount: Money;
  /** Where the provider wants to be paid. Checked against the settlement allowlist. */
  readonly settlementRecipient: string;
  readonly settlementChain: CaipChainId;
  readonly settlementAsset: AssetRef;
  /** Provider-side handle for the thing being bought (ASIN, domain, draft id, offer id). */
  readonly providerRef: string;
  /** Human-readable summary of the offer. Provider text, sanitized, treated as data. */
  readonly summary: string;
  /** Structured, schema-validated terms — the fields a receipt or a human needs. */
  readonly terms: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** sha256 over the canonical quote. What the approval binds to and execution re-checks. */
  readonly quoteHash: string;
}

/** The subset hashed into `quoteHash`. Anything not here can change without invalidating approval. */
export interface CanonicalQuote {
  readonly intentId: string;
  readonly providerId: string;
  readonly providerRef: string;
  readonly providerCost: MoneyJson;
  readonly untchFee: MoneyJson;
  readonly spread: MoneyJson;
  readonly totalUserAmount: MoneyJson;
  readonly maxAuthorisedAmount: MoneyJson;
  readonly settlementRecipient: string;
  readonly settlementChain: string;
  readonly expiresAt: string;
  readonly terms: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The record that binds a human approval to EXACTLY what was approved.
 *
 * Every field here is re-checked immediately before the provider is paid. A policy edited after the
 * approval, a re-quote at a different price, a different recipient — each changes one of these and
 * invalidates the approval rather than silently widening it. This is the §27 authority-boundary
 * principle applied to consumer execution.
 */
export interface ConsumerApproval {
  readonly intentId: string;
  /** The @untch/escalation record this decision came from. */
  readonly escalationId: string;
  readonly pollRef: string;
  readonly required: boolean;
  readonly outcome: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  /** The exact quote that was approved. */
  readonly quoteHash: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyHash: string;
  /** The ceiling the human authorised. Execution above this is refused. */
  readonly maxAmount: Money;
  readonly settlementRecipient: string;
  readonly settlementChain: CaipChainId;
  readonly providerId: string;
  readonly resolvedBy: { readonly channel: string; readonly handle: string } | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Funding
// ─────────────────────────────────────────────────────────────────────────────

/** What the caller is told to pay, and where. Returned the moment an intent reaches AWAITING_FUNDING. */
export interface FundingRequest {
  readonly intentId: string;
  /** The x402 route the caller pays. Priced by a DynamicPrice at exactly `amount`. */
  readonly url: string;
  readonly method: "POST";
  readonly amount: Money;
  readonly expiresAt: string;
}

/** A settled user payment. `UNIQUE (chain, txHash)` AND `UNIQUE (intentId)` in SQL. */
export interface FundingReceipt {
  readonly intentId: string;
  readonly chain: CaipChainId;
  readonly txHash: string;
  readonly amount: Money;
  readonly payer: string | null;
  readonly settledAt: string;
  readonly confirmations: number;
  readonly finalized: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider execution
// ─────────────────────────────────────────────────────────────────────────────

/** One ATTEMPT. Written BEFORE the outbound request, so an ambiguous outcome is never invisible. */
export interface ProviderExecutionRecord {
  readonly executionId: string;
  readonly intentId: string;
  readonly providerId: string;
  readonly attemptNo: number;
  readonly idempotencyKey: string;
  readonly state:
    | "PREPARED"
    | "SENT"
    | "PAID"
    | "ACKNOWLEDGED"
    | "FAILED"
    | "AMBIGUOUS";
  /** The provider's own handle for the resulting order/registration/booking, once known. */
  readonly providerReference: string | null;
  /** The settlement transaction on the provider's rail, once known. */
  readonly settlementTxHash: string | null;
  readonly settlementChain: CaipChainId | null;
  readonly settledAmount: Money | null;
  readonly error: NormalizedProviderError | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** The adapter-level result of `execute`. Mapped into a ProviderExecutionRecord by the orchestrator. */
export interface ProviderExecution {
  readonly providerReference: string;
  readonly settlement: {
    readonly txHash: string | null;
    readonly chain: CaipChainId;
    readonly amount: Money;
    readonly recipient: string;
  };
  /** Provider-reported status immediately after payment. Data, not a delivery guarantee. */
  readonly providerStatus: string;
  /** Schema-validated provider response payload, safe to persist. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly acknowledgedAt: string;
}

export interface ProviderReference {
  readonly providerId: string;
  readonly reference: string;
}

export interface ProviderStatus {
  readonly reference: string;
  readonly state: "PENDING" | "IN_PROGRESS" | "FULFILLED" | "CANCELLED" | "FAILED" | "UNKNOWN";
  readonly detail: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly checkedAt: string;
}

export interface ProviderCancellation {
  readonly cancelled: boolean;
  readonly refundExpected: boolean;
  readonly detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What Untch can actually PROVE about fulfilment, separated from what the provider merely asserts.
 *
 * `providerAttested` is the merchant's word. `untchVerified` is what Untch independently confirmed
 * (a DNS record that resolves, an order id that a status endpoint still returns, a delivery URL that
 * responds). The two are never merged, because collapsing them would make "verified" mean "the
 * merchant said so", which is the exact failure the Proof Engine exists to prevent.
 */
export interface DeliveryEvidence {
  readonly intentId: string;
  readonly providerId: string;
  readonly providerAttested: {
    readonly status: string;
    readonly reference: string;
    readonly attestedAt: string;
    readonly fields: Readonly<Record<string, unknown>>;
  };
  readonly untchVerified: {
    readonly verified: boolean;
    readonly method: "PROVIDER_STATUS_POLL" | "DNS_LOOKUP" | "HTTP_PROBE" | "NONE";
    readonly detail: string;
    readonly verifiedAt: string | null;
  };
  readonly evidenceHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The intent
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsumerIntent {
  readonly intentId: string;
  readonly tenantId: string;
  readonly requestingAgentId: string;
  /** The end user or principal on whose behalf the action runs. May equal the agent. */
  readonly principalId: string;
  readonly action: ConsumerActionType;
  readonly category: ConsumerCategory;
  readonly providerId: string | null;
  /** The validated request parameters. Never raw caller input. */
  readonly request: Readonly<Record<string, unknown>>;

  readonly policyId: string;
  readonly policyVersion: number | null;
  readonly policyHash: string | null;
  /** The §8.2 decision the policy engine returned, verbatim. Null before POLICY_CHECKING. */
  readonly policyDecision: Readonly<Record<string, unknown>> | null;

  readonly quoteId: string | null;
  readonly quoteHash: string | null;
  readonly quoteExpiresAt: string | null;

  readonly fundingAsset: AssetRef | null;
  readonly fundingAmount: Money | null;
  readonly settlementAsset: AssetRef | null;
  readonly settlementAmount: Money | null;
  readonly untchFee: Money | null;
  readonly spread: Money | null;
  readonly maxAuthorisedAmount: Money | null;

  readonly approvalRequired: boolean;
  readonly approvalOutcome: ConsumerApproval["outcome"] | null;

  readonly state: ConsumerIntentState;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;

  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** The §8.1 intentHash when the action was projected onto a SpendIntent. Ties the two models. */
  readonly spendIntentHash: string | null;
  /** The §7.4 receipt id, once the completed action has been recorded. */
  readonly receiptId: string | null;

  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

/** The fields a transition is allowed to patch alongside the state change. */
export interface ConsumerIntentPatch {
  readonly providerId?: string;
  readonly policyVersion?: number;
  readonly policyHash?: string;
  readonly policyDecision?: Readonly<Record<string, unknown>>;
  readonly quoteId?: string;
  readonly quoteHash?: string;
  readonly quoteExpiresAt?: string;
  readonly fundingAsset?: AssetRef;
  readonly fundingAmount?: Money;
  readonly settlementAsset?: AssetRef;
  readonly settlementAmount?: Money;
  readonly untchFee?: Money;
  readonly spread?: Money;
  readonly maxAuthorisedAmount?: Money;
  readonly approvalRequired?: boolean;
  readonly approvalOutcome?: ConsumerApproval["outcome"];
  readonly failureCode?: string;
  readonly failureDetail?: string;
  readonly spendIntentHash?: string;
  readonly receiptId?: string;
  readonly expiresAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery / adapter I-O
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscoveryInput {
  readonly action: ConsumerActionType;
  readonly params: Readonly<Record<string, unknown>>;
  readonly limit: number;
}

export interface DiscoveryOption {
  readonly providerRef: string;
  readonly title: string;
  readonly description: string;
  /** Indicative price. NOT an offer — only `quote` produces a bindable price. */
  readonly indicativePrice: Money | null;
  readonly imageUrl: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface DiscoveryResult {
  readonly providerId: string;
  readonly discoveryId: string;
  readonly options: readonly DiscoveryOption[];
  readonly truncated: boolean;
  readonly retrievedAt: string;
}

export interface QuoteInput {
  readonly action: ConsumerActionType;
  readonly intentId: string;
  readonly providerRef: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ProviderQuote {
  readonly providerId: string;
  readonly providerRef: string;
  readonly cost: Money;
  readonly settlementRecipient: string;
  readonly settlementChain: CaipChainId;
  readonly settlementAsset: AssetRef;
  readonly summary: string;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
}

export interface ExecuteInput {
  readonly action: ConsumerActionType;
  readonly intentId: string;
  readonly providerRef: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly quote: ProviderQuote;
}

/** The final cross-rail receipt view. Every acceptance-criteria field appears here or nowhere. */
export interface ConsumerReceiptView {
  readonly intentId: string;
  readonly action: ConsumerActionType;
  readonly state: ConsumerIntentState;
  readonly userFunding: {
    readonly amount: MoneyJson;
    readonly chain: string;
    readonly txHash: string | null;
    readonly settledAt: string | null;
  } | null;
  readonly providerSettlement: {
    readonly providerId: string;
    readonly amount: MoneyJson;
    readonly chain: string;
    readonly recipient: string;
    readonly txHash: string | null;
    readonly reference: string | null;
  } | null;
  readonly fee: MoneyJson | null;
  readonly spread: MoneyJson | null;
  readonly policy: {
    readonly policyId: string;
    readonly policyVersion: number | null;
    readonly policyHash: string | null;
    readonly decision: string | null;
  };
  readonly approval: {
    readonly required: boolean;
    readonly outcome: string | null;
    readonly resolvedBy: string | null;
    readonly resolvedAt: string | null;
  };
  readonly delivery: DeliveryEvidence | null;
  readonly receiptId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
