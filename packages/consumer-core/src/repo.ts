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

export interface ProviderCapabilityRecord {
  readonly providerId: string;
  readonly capability: string;
  readonly maturity: ProviderMaturity;
  readonly notes: string;
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

export interface TreasuryAccountRecord {
  readonly treasuryRef: string;
  readonly asset: AssetRef;
  readonly purpose: "FUNDING" | "SETTLEMENT";
  /** PUBLIC address only. A private key never reaches this layer. */
  readonly address: string;
  readonly minBalance: Money;
  readonly dailyLimit: Money;
  readonly enabled: boolean;
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
