/**
 * The Consumer Pack storage contract.
 *
 * Two design rules drive the shape of this interface, and both exist to make a class of bug
 * impossible rather than merely discouraged:
 *
 *   1. `transition` is the ONLY way a state changes. It takes the state the caller believes the
 *      intent is in, performs a compare-and-set, and writes the outbox event in the SAME unit of
 *      work. There is no `setState`, no `save(intent)`, and no way to emit an event without a
 *      transition or to transition without an event.
 *
 *   2. Money-moving writes are transactional with their ledger. `recordFunding`, `recordSettlement`
 *      and `completeIntent` each take the ledger group they imply, so a funding receipt cannot exist
 *      without its ledger entries and vice versa.
 *
 * Everything here is implemented twice — in memory (tests, and the honest degraded mode) and against
 * Postgres — exactly as the repository already does for receipts, policies and escalations.
 */

import type {
  SolanaProofGateRecord,
  SolanaProofGateState,
  SolanaProofProgress,
  SolanaProofScope,
} from "./solana-proof-claim";
import type { AssetRef, CaipChainId } from "./assets";
import type { ConsumerEvent, ConsumerEventName, OutboxRecord } from "./events";
import type { LedgerGroup } from "./ledger";
import type { Money } from "./money";
import type { ConsumerIntentState } from "./state";
import type {
  ConsumerApproval,
  ConsumerIntent,
  ConsumerIntentPatch,
  ConsumerQuote,
  DeliveryEvidence,
  FundingReceipt,
  ProviderExecutionRecord,
} from "./types";

export type ProviderMaturity = "verified" | "sandbox" | "experimental" | "disabled";

export interface ProviderRecord {
  readonly providerId: string;
  readonly displayName: string;
  readonly maturity: ProviderMaturity;
  readonly baseUrl: string;
  readonly protocol: "x402" | "mpp" | "siwx" | "none";
  readonly chains: readonly CaipChainId[];
  readonly provenance: string;
  readonly enabled: boolean;
}

/**
 * Why a capability is stuck below `verified`, when the reason is not "Untch has not finished it".
 *
 * This exists so the public surface can tell two very different situations apart. "We have written
 * the adapter but cannot settle on that rail yet" and "the merchant will not let us in without a
 * partner agreement" both render as `experimental` internally, and collapsing them into one label
 * would let an unfinished integration hide behind the merchant.
 *
 *   PARTNER_ACCESS     — the provider requires a commercial agreement, allowlist or credential we
 *                        do not hold. No amount of work on our side unblocks it.
 *   IDENTITY_REQUIRED  — the provider needs a wallet identity or verified profile (SIWX, OTP, an
 *                        ICANN registrant record) that is not configured on this instance.
 *   RAIL_UNAVAILABLE   — the provider settles only on a rail this build cannot sign for.
 *   PROVIDER_UNSUPPORTED — the provider's live contract does not offer this operation at all.
 */
export type CapabilityAccessBlocker =
  | "PARTNER_ACCESS"
  | "IDENTITY_REQUIRED"
  | "RAIL_UNAVAILABLE"
  | "PROVIDER_UNSUPPORTED";

/**
 * How a capability is BOUGHT, which is a different question from what it does.
 *
 * The distinction exists because the lifecycle assumed one answer and there are two.
 *
 *   FULFILMENT  buying a thing. The provider needs to know where to send it and who to tell, so its
 *               price challenge lives on an endpoint that requires a shipping address and contact
 *               details. `shop.purchase` is this shape.
 *   PAID_READ   buying an answer. There is nothing to ship. The price challenge lives on the read
 *               endpoint itself and the request carries only the query. `shop.search` is this shape.
 *
 * WHY THIS IS DATA RATHER THAN A CONDITIONAL
 *
 * The orchestrator called `adapter.quote()` for every capability, and `PurchAdapter.quote` was written
 * for FULFILMENT alone: it demanded `shippingAddress` and `email` and probed `/x402/buy`. So a
 * `shop.search` intent could be created, reach the quote stage, and die there on a missing shipping
 * address — which is exactly what happened to the first production proof attempt.
 *
 * The fix could have been a check on the capability string inside the orchestrator. That would have put
 * provider-shaped knowledge in the provider-neutral layer, and it would have had to be repeated for
 * every future paid read. So the shape is a REGISTRY FACT the orchestrator reads and hands to the
 * adapter, which is the only layer that knows what a shape means over the wire.
 */
export const CAPABILITY_EXECUTION_SHAPES = ["PAID_READ", "FULFILMENT"] as const;
export type CapabilityExecutionShape = (typeof CAPABILITY_EXECUTION_SHAPES)[number];

export function isCapabilityExecutionShape(v: unknown): v is CapabilityExecutionShape {
  return typeof v === "string" && (CAPABILITY_EXECUTION_SHAPES as readonly string[]).includes(v);
}

/**
 * The shape to assume when a capability row does not declare one.
 *
 * FULFILMENT, because that is what every existing row meant before the field existed. A row written by
 * an older build must keep behaving exactly as it did rather than silently acquiring a cheaper path:
 * defaulting to PAID_READ would route a purchase at a read endpoint and drop the shipping address a
 * merchant needs.
 */
export const DEFAULT_CAPABILITY_EXECUTION_SHAPE: CapabilityExecutionShape = "FULFILMENT";

export interface ProviderCapabilityRecord {
  readonly providerId: string;
  readonly capability: string;
  readonly maturity: ProviderMaturity;
  readonly notes: string;
  /** Null ⇒ nothing external is blocking this; it is simply not finished or not yet settled. */
  readonly accessBlocker?: CapabilityAccessBlocker | null;
  /** Absent ⇒ `DEFAULT_CAPABILITY_EXECUTION_SHAPE`, which preserves pre-migration behaviour exactly. */
  readonly executionShape?: CapabilityExecutionShape | null;
}

export interface ProviderHealthRecord {
  readonly providerId: string;
  readonly healthy: boolean;
  readonly latencyMs: number | null;
  readonly httpStatus: number | null;
  readonly detail: string;
  readonly breakerState: "CLOSED" | "OPEN" | "HALF_OPEN";
  readonly observedAt: string;
}

export type PauseScope = "GLOBAL" | "PROVIDER" | "CHAIN" | "ASSET" | "TREASURY_ACCOUNT";

export interface PauseFlag {
  readonly scope: PauseScope;
  readonly target: string;
  readonly paused: boolean;
  readonly reason: string;
  readonly setBy: string;
  readonly updatedAt: string;
}

/**
 * What was observed on chain about a settlement account, at the moment it was registered.
 *
 * WHY THIS IS STORED RATHER THAN RE-READ
 *
 * Registering a treasury and being able to spend from it were one act until now: the account row was
 * written from `rail.address()`, so a public address could not be recorded without a private key being
 * present to derive it. That made "this float exists" and "this process can drain it" the same fact,
 * and it is why an unarmed production deployment reported no Solana settlement account at all.
 *
 * Splitting them needs somewhere to keep the evidence. A public authority alone is not enough to trust
 * a float: on Solana the spendable thing is the associated token account, and an account can be frozen,
 * can carry a delegate that lets a third party move the balance, and can carry a close authority that
 * lets one reclaim the rent and the remainder. None of those are visible from the authority address,
 * and all three change what "0.05 USDC is sitting there" means. So they are read once, at registration,
 * against the registry's own mint and decimals, and stored — which also makes the check auditable after
 * the fact rather than only at the instant it ran.
 *
 * Re-reading them on every plan would be worse than useless: it would put a third-party RPC call on the
 * path of a route whose job is to refuse quickly, and it would mean a transient RPC failure read as a
 * treasury defect.
 */
export interface SettlementAccountAttestation {
  /** Bumped when the set of facts below changes, so an old record is legible as old rather than wrong. */
  readonly registrationVersion: number;
  /** The mint the registry names for this asset. Compared, never accepted from a caller. */
  readonly mint: string | null;
  readonly decimals: number;
  /** The PUBLIC spending authority. Base58 on Solana, a checksummed address on an EVM rail. */
  readonly authority: string;
  /** The derived token account the balance actually sits in. Null on rails that have no such concept. */
  readonly tokenAccount: string | null;
  readonly tokenProgram: string | null;
  /** The token account's own owner. Must equal `authority`, or the balance is not ours to spend. */
  readonly tokenAccountOwner: string | null;
  readonly accountState: string | null;
  /** Any of these being non-null is a refusal, not a note. A delegate can move the float. */
  readonly delegate: string | null;
  readonly closeAuthority: string | null;
  /** Atomic units, as decimal strings. Bigints do not survive JSON, and a number would lose precision. */
  readonly observedTokenBalance: string;
  readonly observedNativeBalance: string;
  readonly observedAt: string;
  readonly provenance: {
    readonly source: string;
    /** A truncated one-way digest naming which operator credential acted. Never replayable as one. */
    readonly operatorKeyId: string;
    readonly requestHash: string;
    readonly servingCommit: string | null;
    readonly servingDeploymentId: string | null;
    /** Host only. The RPC key lives in the URL path and must never be recorded. */
    readonly rpcHost: string | null;
  };
}

export interface TreasuryAccountRecord {
  readonly treasuryRef: string;
  readonly asset: AssetRef;
  readonly purpose: "FUNDING" | "SETTLEMENT";
  /** PUBLIC address only. A private key never reaches this layer. */
  readonly address: string;
  readonly minBalance: Money;
  readonly dailyLimit: Money;
  readonly enabled: boolean;
  /**
   * Null for the accounts that predate registration — the Base settlement float and the X Layer
   * funding row. Null means "not attested", never "attested clean": every consumer of this field
   * treats absence as a reason to refuse rather than a reason to proceed.
   */
  readonly attestation?: SettlementAccountAttestation | null;
}

/**
 * One immutable statement that Untch checked a delivery, and what it read to do so.
 *
 * Separate from `DeliveryEvidence` on purpose. That record is written at execution time and describes
 * what the provider attested; this one is written whenever verification actually ran, which may be much
 * later. Collapsing them would make a receipt unable to distinguish "verified at settlement" from
 * "verified afterwards", and the second is the honest description of a redrive.
 */
export interface DeliveryVerificationRecord {
  readonly verificationId: string;
  readonly intentId: string;
  /** Bumped when the checks change, so two versions can disagree in the record rather than in silence. */
  readonly verifierVersion: string;
  /** Hash over every persisted input read. Identical inputs produce an identical row. */
  readonly evidenceDigest: string;
  readonly providerId: string;
  readonly capability: string;
  readonly executionShape: string;
  readonly method: DeliveryEvidence["untchVerified"]["method"];
  readonly verified: boolean;
  readonly detail: string;
  readonly requestHash: string | null;
  readonly resultHash: string | null;
  readonly quoteHash: string | null;
  readonly settlementTx: string | null;
  readonly settledAmount: string | null;
  readonly settlementChain: string | null;
  readonly originalReceiptId: string | null;
  readonly supersedingReceiptId: string | null;
  /** Every reason a verification failed. Kept because a failed check is evidence too. */
  readonly refusals: readonly { readonly code: string; readonly detail: string }[];
  readonly verifiedAt: string;
}

export interface TreasuryBalanceObservation {
  readonly treasuryRef: string;
  readonly onchain: Money;
  readonly ledger: Money;
  readonly drift: Money;
  readonly observedAt: string;
}

export interface ProviderLimitRecord {
  readonly providerId: string;
  readonly asset: AssetRef;
  readonly perTxMax: Money;
  readonly dailyMax: Money;
}

export interface CapabilityRecord {
  readonly capabilityId: string;
  readonly intentId: string;
  readonly providerId: string;
  readonly treasuryRef: string;
  readonly asset: AssetRef;
  readonly maxAmount: Money;
  readonly allowedRecipients: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly spentAmount: Money | null;
}

export interface CreateIntentInput {
  readonly intentId: string;
  readonly tenantId: string;
  readonly requestingAgentId: string;
  readonly principalId: string;
  readonly action: string;
  readonly category: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly policyId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string | null;
}

/** The event a transition emits. `data` is already redacted by the caller. */
export interface TransitionEvent {
  readonly name: ConsumerEventName;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TransitionResult {
  readonly intent: ConsumerIntent;
  readonly event: ConsumerEvent;
}

export interface ConsumerStore {
  // ── intents ───────────────────────────────────────────────────────────────
  createIntent(input: CreateIntentInput, event: TransitionEvent): Promise<TransitionResult>;
  getIntent(intentId: string): Promise<ConsumerIntent | null>;
  /** Tenant-scoped read. The ONLY read a request handler may use — enforces isolation at the query. */
  getIntentForTenant(tenantId: string, intentId: string): Promise<ConsumerIntent | null>;
  findByIdempotencyKey(tenantId: string, key: string): Promise<ConsumerIntent | null>;
  listIntents(filter: {
    readonly tenantId?: string;
    readonly state?: ConsumerIntentState;
    readonly limit: number;
  }): Promise<readonly ConsumerIntent[]>;
  /**
   * Compare-and-set. Throws StaleIntentStateError when the row is no longer in `expectedFrom`, and
   * InvalidStateTransitionError when the edge is not in the map. Writes the outbox event in the
   * same unit of work and assigns its `seq` from the intent's counter.
   */
  transition(
    intentId: string,
    expectedFrom: ConsumerIntentState,
    to: ConsumerIntentState,
    patch: ConsumerIntentPatch,
    event: TransitionEvent,
  ): Promise<TransitionResult>;
  /** Intents past `expires_at` in an expirable state. The sweeper's working set. */
  findExpirable(nowIso: string, limit: number): Promise<readonly ConsumerIntent[]>;

  // ── quotes ────────────────────────────────────────────────────────────────
  insertQuote(quote: ConsumerQuote): Promise<void>;
  getQuote(quoteId: string): Promise<ConsumerQuote | null>;
  getQuoteByHash(quoteHash: string): Promise<ConsumerQuote | null>;

  // ── approvals ─────────────────────────────────────────────────────────────
  upsertApproval(approval: ConsumerApproval): Promise<void>;
  getApproval(intentId: string): Promise<ConsumerApproval | null>;
  getApprovalByPollRef(pollRef: string): Promise<ConsumerApproval | null>;
  resolveApproval(
    intentId: string,
    outcome: ConsumerApproval["outcome"],
    resolvedBy: { readonly channel: string; readonly handle: string } | null,
    resolvedAt: string,
  ): Promise<void>;

  // ── funding ───────────────────────────────────────────────────────────────
  /**
   * Insert the funding receipt AND its ledger group atomically. Returns `false` when the receipt
   * already exists (same intent, or same on-chain tx already counted) — the caller treats that as a
   * duplicate webhook/settlement, not as an error.
   */
  recordFunding(receipt: FundingReceipt, ledger: LedgerGroup): Promise<boolean>;
  getFunding(intentId: string): Promise<FundingReceipt | null>;
  markFundingFinalized(intentId: string, confirmations: number): Promise<void>;

  // ── provider executions ───────────────────────────────────────────────────
  /** Written BEFORE the outbound request. Fails if the idempotency key was already used. */
  prepareExecution(record: ProviderExecutionRecord): Promise<void>;
  updateExecution(
    executionId: string,
    patch: Partial<Pick<ProviderExecutionRecord,
      "state" | "providerReference" | "settlementTxHash" | "settlementChain" | "settledAmount" | "error" | "finishedAt">>,
  ): Promise<void>;
  getExecution(executionId: string): Promise<ProviderExecutionRecord | null>;
  listExecutions(intentId: string): Promise<readonly ProviderExecutionRecord[]>;
  /** SENT/AMBIGUOUS rows older than a cutoff — what the reconciler must resolve. */
  findAmbiguousExecutions(olderThanIso: string, limit: number): Promise<readonly ProviderExecutionRecord[]>;
  /** Settlement + its ledger group, atomically. */
  recordSettlement(executionId: string, ledger: LedgerGroup): Promise<void>;

  // ── delivery ──────────────────────────────────────────────────────────────
  upsertDeliveryEvidence(evidence: DeliveryEvidence): Promise<void>;
  getDeliveryEvidence(intentId: string): Promise<DeliveryEvidence | null>;

  /**
   * Record a delivery verification. Idempotent on (intentId, verifierVersion, evidenceDigest).
   *
   * Returns the row that ended up stored — the new one, or the existing one when an identical redrive
   * collided with it. A caller therefore cannot tell a first run from a repeat by the return value, and
   * does not need to: both mean "this verification is on record", which is the only thing it acts on.
   */
  recordDeliveryVerification(record: DeliveryVerificationRecord): Promise<DeliveryVerificationRecord>;
  /** The newest verification for an intent, or null. Never merged into the delivery evidence. */
  latestDeliveryVerification(intentId: string): Promise<DeliveryVerificationRecord | null>;
  listDeliveryVerifications(intentId: string): Promise<readonly DeliveryVerificationRecord[]>;

  // ── ledger ────────────────────────────────────────────────────────────────
  /** Validates balance, then appends. Rejects a duplicate (intentId, kind) for non-ADJUSTMENT groups. */
  appendLedgerGroup(group: LedgerGroup): Promise<void>;
  ledgerGroupsForIntent(intentId: string): Promise<readonly LedgerGroup[]>;
  /**
   * The two halves of a cross-rail treasury sweep, written in ONE transaction.
   *
   * Separate calls would be wrong, not merely untidy: a crash between them leaves one rail's clearing
   * position retired and the other's not, and the book stops summing to zero with no single row to
   * point at. They describe one movement, so they commit or fail as one.
   */
  appendTreasuryTransfer(groups: readonly [LedgerGroup, LedgerGroup]): Promise<void>;
  /** Every group touching one rail, newest last. The reconciliation-report input. */
  ledgerGroupsForAsset(asset: AssetRef, limit: number): Promise<readonly LedgerGroup[]>;
  accountBalance(accountId: string, asset: AssetRef): Promise<Money>;
  /** Sum of an account's entries within a UTC day — the daily-limit input. */
  accountDaySpend(accountId: string, asset: AssetRef, dayKeyUtc: string): Promise<Money>;

  // ── outbox / events ───────────────────────────────────────────────────────
  pendingOutbox(limit: number): Promise<readonly OutboxRecord[]>;
  markDispatched(eventId: string): Promise<void>;
  markDispatchFailed(eventId: string, error: string): Promise<void>;
  /** Events for an intent with seq > cursor. Backs SSE Last-Event-ID resume. */
  eventsSince(intentId: string, afterSeq: number, limit: number): Promise<readonly ConsumerEvent[]>;

  // ── provider registry ─────────────────────────────────────────────────────
  upsertProvider(record: ProviderRecord): Promise<void>;
  getProvider(providerId: string): Promise<ProviderRecord | null>;
  listProviders(): Promise<readonly ProviderRecord[]>;
  upsertCapability(record: ProviderCapabilityRecord): Promise<void>;
  listCapabilities(providerId: string): Promise<readonly ProviderCapabilityRecord[]>;
  recordHealth(record: ProviderHealthRecord): Promise<void>;
  latestHealth(providerId: string): Promise<ProviderHealthRecord | null>;

  // ── pause flags ───────────────────────────────────────────────────────────
  setPause(flag: PauseFlag): Promise<void>;
  listPauses(): Promise<readonly PauseFlag[]>;

  // ── treasury ──────────────────────────────────────────────────────────────
  upsertTreasuryAccount(record: TreasuryAccountRecord): Promise<void>;
  getTreasuryAccount(treasuryRef: string): Promise<TreasuryAccountRecord | null>;
  findTreasuryAccount(
    chain: CaipChainId,
    token: string,
    purpose: "FUNDING" | "SETTLEMENT",
  ): Promise<TreasuryAccountRecord | null>;
  listTreasuryAccounts(): Promise<readonly TreasuryAccountRecord[]>;
  recordBalanceObservation(obs: TreasuryBalanceObservation): Promise<void>;
  latestBalanceObservation(treasuryRef: string): Promise<TreasuryBalanceObservation | null>;
  upsertProviderLimit(record: ProviderLimitRecord): Promise<void>;
  getProviderLimit(providerId: string, chain: CaipChainId, token: string): Promise<ProviderLimitRecord | null>;

  // ── payment capabilities ──────────────────────────────────────────────────
  issueCapability(record: CapabilityRecord): Promise<void>;
  /**
   * Redeem exactly once under a row lock. Returns the record on success; `null` when it was already
   * consumed, expired, or never existed. A second redemption is a refusal, never a second payment.
   */
  consumeCapability(capabilityId: string, spent: Money, atIso: string): Promise<CapabilityRecord | null>;

  // ── the one-shot Solana proof gate ────────────────────────────────────────
  //
  // Separate from the capability tables on purpose. A capability answers "may this intent spend up to
  // X with this provider". The proof gate answers a different and narrower question: "may production
  // reach the Solana signer AT ALL, this once". Folding the second into the first would make an
  // operational safety measure indistinguishable from ordinary authorisation.

  /** Create the ARMED row for a scope, or return the existing row for that exact scope. */
  armSolanaProofGate(scope: SolanaProofScope, atIso: string): Promise<SolanaProofGateRecord>;

  /**
   * Atomically move ARMED to CLAIMED, returning the claimed record or null if it could not be won.
   *
   * MUST be a compare-and-set. Two workers calling this concurrently must see exactly one non-null
   * result, and a restart while a row is CLAIMED must keep returning null.
   */
  claimSolanaProofGate(
    scopeHash: string,
    executionId: string,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null>;

  /** Append evidence as it becomes known. Never resets a field and never widens authority. */
  recordSolanaProofProgress(
    scopeHash: string,
    progress: SolanaProofProgress,
    state: SolanaProofGateState | null,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null>;

  getSolanaProofGate(scopeHash: string): Promise<SolanaProofGateRecord | null>;

  /** Every gate row, newest first. For the read-only operator diagnostic. */
  listSolanaProofGates(limit: number): Promise<readonly SolanaProofGateRecord[]>;

  /**
   * Release a gate that provably never reached the signer.
   *
   * Returns null when the record's own evidence forbids it. The refusal is the point: a FAILED attempt
   * is not proof that nothing was signed, and this is the one transition that could turn a spent gate
   * back into a spendable one.
   */
  releaseSolanaProofGatePreSign(
    scopeHash: string,
    reason: string,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null>;
  getCapability(capabilityId: string): Promise<CapabilityRecord | null>;

  // ── idempotency ───────────────────────────────────────────────────────────
  /** Returns the existing intentId when the (tenant, key) pair was already used, else null. */
  claimIdempotency(args: {
    readonly tenantId: string;
    readonly key: string;
    readonly intentId: string;
    readonly action: string;
    readonly requestHash: string;
  }): Promise<string | null>;

  close(): Promise<void>;
}
