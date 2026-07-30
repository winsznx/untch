/**
 * In-memory ConsumerStore.
 *
 * This is not a toy. It is the reference implementation the whole test suite runs against, and it
 * enforces EVERY invariant the SQL schema enforces — the unique constraints, the compare-and-set,
 * the append-only ledger, the single-use capability. That symmetry is the point: a test that passes
 * here and fails against Postgres means one of the two lied, and both are written from the same list.
 *
 * It is deliberately NOT wired into the ASP as a fallback. An unconfigured DATABASE_URL yields a 503
 * with a named reason, exactly as the policy/score/report stores already do — a consumer purchase
 * silently backed by a Map would be precisely the kind of fake this repository refuses to ship.
 */

import type { AssetRef, CaipChainId } from "./assets";
import {
  canReleasePreSign,
  solanaProofScopeHash,
  type SolanaProofGateRecord,
  type SolanaProofGateState,
  type SolanaProofProgress,
  type SolanaProofScope,
} from "./solana-proof-claim";
import { assetKey } from "./assets";
import type { ConsumerEvent, OutboxRecord } from "./events";
import { assertGroupBalanced, type LedgerGroup } from "./ledger";
import { addMoney, money, type Money } from "./money";
import {
  assertTransition,
  IdempotencyConflictError,
  StaleIntentStateError,
  type ConsumerIntentState,
} from "./state";
import type {
  ConsumerApproval,
  ConsumerIntent,
  ConsumerIntentPatch,
  ConsumerQuote,
  DeliveryEvidence,
  FundingReceipt,
  ProviderExecutionRecord,
} from "./types";
import type {
  CapabilityRecord,
  ConsumerStore,
  CreateIntentInput,
  PauseFlag,
  ProviderCapabilityRecord,
  ProviderHealthRecord,
  ProviderLimitRecord,
  ProviderRecord,
  TransitionEvent,
  TransitionResult,
  TreasuryAccountRecord,
  TreasuryBalanceObservation,
} from "./repo";

let eventCounter = 0;

function nextEventId(): string {
  eventCounter += 1;
  return `evt_${eventCounter.toString(36).padStart(8, "0")}`;
}

/** Local mutable mirror of ConsumerIntent — the readonly public type is rebuilt on every read. */
interface IntentRow {
  intent: ConsumerIntent;
  eventSeq: number;
}

export class InMemoryConsumerStore implements ConsumerStore {
  private readonly intents = new Map<string, IntentRow>();
  private readonly idempotency = new Map<string, string>();
  private readonly quotes = new Map<string, ConsumerQuote>();
  private readonly quotesByHash = new Map<string, string>();
  private readonly approvals = new Map<string, ConsumerApproval>();
  private readonly approvalsByPollRef = new Map<string, string>();
  private readonly funding = new Map<string, FundingReceipt>();
  private readonly fundingTxIndex = new Set<string>();
  private readonly executions = new Map<string, ProviderExecutionRecord>();
  private readonly executionIdemIndex = new Set<string>();
  private readonly delivery = new Map<string, DeliveryEvidence>();
  private readonly ledgerGroups: LedgerGroup[] = [];
  private readonly ledgerGroupKeys = new Set<string>();
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly capabilities = new Map<string, ProviderCapabilityRecord>();
  private readonly health = new Map<string, ProviderHealthRecord>();
  private readonly pauses = new Map<string, PauseFlag>();
  private readonly treasury = new Map<string, TreasuryAccountRecord>();
  private readonly balances = new Map<string, TreasuryBalanceObservation>();
  private readonly providerLimits = new Map<string, ProviderLimitRecord>();
  private readonly paymentCapabilities = new Map<string, CapabilityRecord>();

  constructor(private readonly clock: () => number = Date.now) {}

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  // ── intents ────────────────────────────────────────────────────────────────

  async createIntent(input: CreateIntentInput, event: TransitionEvent): Promise<TransitionResult> {
    const idemKey = `${input.tenantId}|${input.idempotencyKey}`;
    if (this.idempotency.has(idemKey)) {
      throw new IdempotencyConflictError(input.tenantId, input.idempotencyKey);
    }
    const now = this.nowIso();
    const intent: ConsumerIntent = {
      intentId: input.intentId,
      tenantId: input.tenantId,
      requestingAgentId: input.requestingAgentId,
      principalId: input.principalId,
      action: input.action as ConsumerIntent["action"],
      category: input.category as ConsumerIntent["category"],
      providerId: null,
      request: input.request,
      policyId: input.policyId,
      policyVersion: null,
      policyHash: null,
      policyDecision: null,
      quoteId: null,
      quoteHash: null,
      quoteExpiresAt: null,
      fundingAsset: null,
      fundingAmount: null,
      settlementAsset: null,
      settlementAmount: null,
      untchFee: null,
      spread: null,
      maxAuthorisedAmount: null,
      approvalRequired: false,
      approvalOutcome: null,
      state: "CREATED",
      failureCode: null,
      failureDetail: null,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      spendIntentHash: null,
      receiptId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    const row: IntentRow = { intent, eventSeq: 0 };
    this.intents.set(intent.intentId, row);
    this.idempotency.set(idemKey, intent.intentId);
    const emitted = this.appendEvent(row, "CREATED", event);
    return { intent: row.intent, event: emitted };
  }

  async getIntent(intentId: string): Promise<ConsumerIntent | null> {
    return this.intents.get(intentId)?.intent ?? null;
  }

  async getIntentForTenant(tenantId: string, intentId: string): Promise<ConsumerIntent | null> {
    const found = this.intents.get(intentId)?.intent ?? null;
    return found && found.tenantId === tenantId ? found : null;
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<ConsumerIntent | null> {
    const id = this.idempotency.get(`${tenantId}|${key}`);
    return id ? (this.intents.get(id)?.intent ?? null) : null;
  }

  async listIntents(filter: {
    readonly tenantId?: string;
    readonly state?: ConsumerIntentState;
    readonly limit: number;
  }): Promise<readonly ConsumerIntent[]> {
    const out: ConsumerIntent[] = [];
    for (const row of this.intents.values()) {
      if (filter.tenantId !== undefined && row.intent.tenantId !== filter.tenantId) continue;
      if (filter.state !== undefined && row.intent.state !== filter.state) continue;
      out.push(row.intent);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out.slice(0, filter.limit);
  }

  async transition(
    intentId: string,
    expectedFrom: ConsumerIntentState,
    to: ConsumerIntentState,
    patch: ConsumerIntentPatch,
    event: TransitionEvent,
  ): Promise<TransitionResult> {
    assertTransition(expectedFrom, to);
    const row = this.intents.get(intentId);
    if (!row) throw new StaleIntentStateError(intentId, expectedFrom);
    // The compare-and-set. In Postgres this is `WHERE id = $1 AND state = $2`.
    if (row.intent.state !== expectedFrom) throw new StaleIntentStateError(intentId, expectedFrom);

    row.intent = { ...row.intent, ...stripUndefined(patch), state: to, updatedAt: this.nowIso() };
    const emitted = this.appendEvent(row, to, event);
    return { intent: row.intent, event: emitted };
  }

  async findExpirable(nowIso: string, limit: number): Promise<readonly ConsumerIntent[]> {
    const { EXPIRABLE_STATES } = await import("./state");
    const out: ConsumerIntent[] = [];
    for (const row of this.intents.values()) {
      const { intent } = row;
      if (!EXPIRABLE_STATES.has(intent.state)) continue;
      if (intent.expiresAt === null || intent.expiresAt > nowIso) continue;
      out.push(intent);
      if (out.length >= limit) break;
    }
    return out;
  }

  private appendEvent(row: IntentRow, state: ConsumerIntentState, event: TransitionEvent): ConsumerEvent {
    row.eventSeq += 1;
    const evt: ConsumerEvent = {
      eventId: nextEventId(),
      intentId: row.intent.intentId,
      tenantId: row.intent.tenantId,
      seq: row.eventSeq,
      name: event.name,
      state,
      correlationId: row.intent.correlationId,
      data: event.data,
      occurredAt: this.nowIso(),
    };
    this.outbox.set(evt.eventId, { ...evt, dispatched: false, attempts: 0, lastError: null });
    return evt;
  }

  // ── quotes ─────────────────────────────────────────────────────────────────

  async insertQuote(quote: ConsumerQuote): Promise<void> {
    if (this.quotesByHash.has(quote.quoteHash)) {
      throw new Error(`quote hash ${quote.quoteHash} already exists — quotes are immutable`);
    }
    this.quotes.set(quote.quoteId, quote);
    this.quotesByHash.set(quote.quoteHash, quote.quoteId);
  }

  async getQuote(quoteId: string): Promise<ConsumerQuote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  async getQuoteByHash(quoteHash: string): Promise<ConsumerQuote | null> {
    const id = this.quotesByHash.get(quoteHash);
    return id ? (this.quotes.get(id) ?? null) : null;
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  async upsertApproval(approval: ConsumerApproval): Promise<void> {
    this.approvals.set(approval.intentId, approval);
    this.approvalsByPollRef.set(approval.pollRef, approval.intentId);
  }

  async getApproval(intentId: string): Promise<ConsumerApproval | null> {
    return this.approvals.get(intentId) ?? null;
  }

  async getApprovalByPollRef(pollRef: string): Promise<ConsumerApproval | null> {
    const id = this.approvalsByPollRef.get(pollRef);
    return id ? (this.approvals.get(id) ?? null) : null;
  }

  async resolveApproval(
    intentId: string,
    outcome: ConsumerApproval["outcome"],
    resolvedBy: { readonly channel: string; readonly handle: string } | null,
    resolvedAt: string,
  ): Promise<void> {
    const prior = this.approvals.get(intentId);
    if (!prior) throw new Error(`no approval for intent ${intentId}`);
    this.approvals.set(intentId, { ...prior, outcome, resolvedBy, resolvedAt });
  }

  // ── funding ────────────────────────────────────────────────────────────────

  async recordFunding(receipt: FundingReceipt, ledger: LedgerGroup): Promise<boolean> {
    const txKey = `${receipt.chain}|${receipt.txHash.toLowerCase()}`;
    // Both uniqueness constraints, in the same order the SQL enforces them.
    if (this.funding.has(receipt.intentId)) return false;
    if (this.fundingTxIndex.has(txKey)) return false;
    assertGroupBalanced(ledger);
    this.funding.set(receipt.intentId, receipt);
    this.fundingTxIndex.add(txKey);
    await this.appendLedgerGroup(ledger);
    return true;
  }

  async getFunding(intentId: string): Promise<FundingReceipt | null> {
    return this.funding.get(intentId) ?? null;
  }

  async markFundingFinalized(intentId: string, confirmations: number): Promise<void> {
    const prior = this.funding.get(intentId);
    if (!prior) throw new Error(`no funding receipt for intent ${intentId}`);
    this.funding.set(intentId, { ...prior, confirmations, finalized: true });
  }

  // ── executions ─────────────────────────────────────────────────────────────

  async prepareExecution(record: ProviderExecutionRecord): Promise<void> {
    const idemKey = `${record.providerId}|${record.idempotencyKey}`;
    if (this.executionIdemIndex.has(idemKey)) {
      throw new Error(
        `provider execution idempotency key already used for ${record.providerId} — ` +
          "refusing to send a second request that could duplicate a purchase",
      );
    }
    for (const existing of this.executions.values()) {
      if (existing.intentId === record.intentId && existing.attemptNo === record.attemptNo) {
        throw new Error(`attempt ${record.attemptNo} already exists for intent ${record.intentId}`);
      }
    }
    this.executionIdemIndex.add(idemKey);
    this.executions.set(record.executionId, record);
  }

  async updateExecution(
    executionId: string,
    patch: Partial<
      Pick<
        ProviderExecutionRecord,
        "state" | "providerReference" | "settlementTxHash" | "settlementChain" | "settledAmount" | "error" | "finishedAt"
      >
    >,
  ): Promise<void> {
    const prior = this.executions.get(executionId);
    if (!prior) throw new Error(`no execution ${executionId}`);
    this.executions.set(executionId, { ...prior, ...stripUndefined(patch) });
  }

  async getExecution(executionId: string): Promise<ProviderExecutionRecord | null> {
    return this.executions.get(executionId) ?? null;
  }

  async listExecutions(intentId: string): Promise<readonly ProviderExecutionRecord[]> {
    return [...this.executions.values()]
      .filter((e) => e.intentId === intentId)
      .sort((a, b) => a.attemptNo - b.attemptNo);
  }

  async findAmbiguousExecutions(
    olderThanIso: string,
    limit: number,
  ): Promise<readonly ProviderExecutionRecord[]> {
    return [...this.executions.values()]
      .filter((e) => (e.state === "SENT" || e.state === "AMBIGUOUS") && e.startedAt <= olderThanIso)
      .slice(0, limit);
  }

  async recordSettlement(executionId: string, ledger: LedgerGroup): Promise<void> {
    const prior = this.executions.get(executionId);
    if (!prior) throw new Error(`no execution ${executionId}`);
    assertGroupBalanced(ledger);
    await this.appendLedgerGroup(ledger);
    this.executions.set(executionId, { ...prior, state: "PAID" });
  }

  // ── delivery ───────────────────────────────────────────────────────────────

  async upsertDeliveryEvidence(evidence: DeliveryEvidence): Promise<void> {
    this.delivery.set(evidence.intentId, evidence);
  }

  async getDeliveryEvidence(intentId: string): Promise<DeliveryEvidence | null> {
    return this.delivery.get(intentId) ?? null;
  }

  // ── ledger ─────────────────────────────────────────────────────────────────

  async appendLedgerGroup(group: LedgerGroup): Promise<void> {
    assertGroupBalanced(group);
    // Mirrors `consumer_ledger_group_once_idx`: ADJUSTMENT is the escape hatch, and a
    // TREASURY_TRANSFER belongs to no intent, so neither is once-per-intent.
    if (group.kind !== "ADJUSTMENT" && group.kind !== "TREASURY_TRANSFER" && group.intentId !== null) {
      const key = `${group.intentId}|${group.kind}`;
      if (this.ledgerGroupKeys.has(key)) {
        throw new Error(
          `ledger group ${group.kind} already exists for intent ${group.intentId} — ` +
            "a second one would mean the intent was executed twice",
        );
      }
      this.ledgerGroupKeys.add(key);
    }
    this.ledgerGroups.push(group);
  }

  async ledgerGroupsForIntent(intentId: string): Promise<readonly LedgerGroup[]> {
    return this.ledgerGroups.filter((g) => g.intentId === intentId);
  }

  async appendTreasuryTransfer(groups: readonly [LedgerGroup, LedgerGroup]): Promise<void> {
    for (const g of groups) assertGroupBalanced(g);
    for (const g of groups) await this.appendLedgerGroup(g);
  }

  async ledgerGroupsForAsset(asset: AssetRef, limit: number): Promise<readonly LedgerGroup[]> {
    return this.ledgerGroups.filter((g) => assetKey(g.asset) === assetKey(asset)).slice(-limit);
  }

  async accountBalance(accountId: string, asset: AssetRef): Promise<Money> {
    let total = money(0n, asset);
    for (const g of this.ledgerGroups) {
      if (assetKey(g.asset) !== assetKey(asset)) continue;
      for (const e of g.entries) {
        if (e.accountId === accountId) total = addMoney(total, e.amount);
      }
    }
    return total;
  }

  async accountDaySpend(accountId: string, asset: AssetRef, dayKeyUtc: string): Promise<Money> {
    let total = money(0n, asset);
    for (const g of this.ledgerGroups) {
      if (assetKey(g.asset) !== assetKey(asset)) continue;
      if (!g.createdAt.startsWith(dayKeyUtc)) continue;
      for (const e of g.entries) {
        // Spend is a credit (negative) on the treasury account; report it as a positive magnitude.
        if (e.accountId === accountId && e.amount.amount < 0n) {
          total = addMoney(total, money(-e.amount.amount, asset));
        }
      }
    }
    return total;
  }

  // ── outbox ─────────────────────────────────────────────────────────────────

  async pendingOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((r) => !r.dispatched)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))
      .slice(0, limit);
  }

  async markDispatched(eventId: string): Promise<void> {
    const prior = this.outbox.get(eventId);
    if (!prior) return;
    this.outbox.set(eventId, { ...prior, dispatched: true });
  }

  async markDispatchFailed(eventId: string, error: string): Promise<void> {
    const prior = this.outbox.get(eventId);
    if (!prior) return;
    this.outbox.set(eventId, { ...prior, attempts: prior.attempts + 1, lastError: error });
  }

  async eventsSince(intentId: string, afterSeq: number, limit: number): Promise<readonly ConsumerEvent[]> {
    return [...this.outbox.values()]
      .filter((r) => r.intentId === intentId && r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(({ dispatched: _d, attempts: _a, lastError: _e, ...evt }) => evt);
  }

  // ── provider registry ──────────────────────────────────────────────────────

  async upsertProvider(record: ProviderRecord): Promise<void> {
    this.providers.set(record.providerId, record);
  }

  async getProvider(providerId: string): Promise<ProviderRecord | null> {
    return this.providers.get(providerId) ?? null;
  }

  async listProviders(): Promise<readonly ProviderRecord[]> {
    return [...this.providers.values()];
  }

  async upsertCapability(record: ProviderCapabilityRecord): Promise<void> {
    this.capabilities.set(`${record.providerId}|${record.capability}`, record);
  }

  async listCapabilities(providerId: string): Promise<readonly ProviderCapabilityRecord[]> {
    return [...this.capabilities.values()].filter((c) => c.providerId === providerId);
  }

  async recordHealth(record: ProviderHealthRecord): Promise<void> {
    this.health.set(record.providerId, record);
  }

  async latestHealth(providerId: string): Promise<ProviderHealthRecord | null> {
    return this.health.get(providerId) ?? null;
  }

  // ── pause flags ────────────────────────────────────────────────────────────

  async setPause(flag: PauseFlag): Promise<void> {
    this.pauses.set(`${flag.scope}|${flag.target}`, flag);
  }

  async listPauses(): Promise<readonly PauseFlag[]> {
    return [...this.pauses.values()];
  }

  // ── treasury ───────────────────────────────────────────────────────────────

  async upsertTreasuryAccount(record: TreasuryAccountRecord): Promise<void> {
    // Mirrors the Postgres COALESCE: an upsert carrying no attestation must not erase one that a
    // registration wrote. The two stores disagreeing about that would mean a behaviour tests could
    // never catch, because tests run against this one.
    const existing = this.treasury.get(record.treasuryRef);
    const attestation = record.attestation ?? existing?.attestation ?? null;
    this.treasury.set(record.treasuryRef, { ...record, attestation });
  }

  async getTreasuryAccount(treasuryRef: string): Promise<TreasuryAccountRecord | null> {
    return this.treasury.get(treasuryRef) ?? null;
  }

  async findTreasuryAccount(
    chain: CaipChainId,
    token: string,
    purpose: "FUNDING" | "SETTLEMENT",
  ): Promise<TreasuryAccountRecord | null> {
    for (const t of this.treasury.values()) {
      if (t.asset.chain === chain && t.asset.symbol === token && t.purpose === purpose) return t;
    }
    return null;
  }

  async listTreasuryAccounts(): Promise<readonly TreasuryAccountRecord[]> {
    return [...this.treasury.values()];
  }

  async recordBalanceObservation(obs: TreasuryBalanceObservation): Promise<void> {
    this.balances.set(obs.treasuryRef, obs);
  }

  async latestBalanceObservation(treasuryRef: string): Promise<TreasuryBalanceObservation | null> {
    return this.balances.get(treasuryRef) ?? null;
  }

  async upsertProviderLimit(record: ProviderLimitRecord): Promise<void> {
    this.providerLimits.set(`${record.providerId}|${assetKey(record.asset)}`, record);
  }

  async getProviderLimit(
    providerId: string,
    chain: CaipChainId,
    token: string,
  ): Promise<ProviderLimitRecord | null> {
    for (const l of this.providerLimits.values()) {
      if (l.providerId === providerId && l.asset.chain === chain && l.asset.symbol === token) return l;
    }
    return null;
  }

  // ── payment capabilities ───────────────────────────────────────────────────

  async issueCapability(record: CapabilityRecord): Promise<void> {
    for (const c of this.paymentCapabilities.values()) {
      if (c.intentId === record.intentId && c.consumedAt === null) {
        throw new Error(
          `intent ${record.intentId} already has a live payment capability — ` +
            "a second mint would be a second authority to spend",
        );
      }
    }
    this.paymentCapabilities.set(record.capabilityId, record);
  }

  async consumeCapability(
    capabilityId: string,
    spent: Money,
    atIso: string,
  ): Promise<CapabilityRecord | null> {
    const prior = this.paymentCapabilities.get(capabilityId);
    if (!prior) return null;
    if (prior.consumedAt !== null) return null;
    if (prior.expiresAt <= atIso) return null;
    const consumed: CapabilityRecord = { ...prior, consumedAt: atIso, spentAmount: spent };
    this.paymentCapabilities.set(capabilityId, consumed);
    return consumed;
  }

  // ── the one-shot Solana proof gate ────────────────────────────────────────

  private proofGates = new Map<string, SolanaProofGateRecord>();

  async armSolanaProofGate(scope: SolanaProofScope, atIso: string): Promise<SolanaProofGateRecord> {
    const scopeHash = solanaProofScopeHash(scope);
    const existing = this.proofGates.get(scopeHash);
    // Idempotent by scope. Two workers arming the same proof converge on one row rather than each
    // creating a gate that looks unclaimed.
    if (existing) return existing;
    const record: SolanaProofGateRecord = {
      scopeHash,
      state: "ARMED",
      scope,
      claimedByExecution: null,
      claimedAt: null,
      signerReachedAt: null,
      credentialCreatedAt: null,
      txSignature: null,
      txSubmittedAt: null,
      settledAt: null,
      confirmedSlot: null,
      txError: null,
      preTokenAmount: null,
      postTokenAmount: null,
      tokenDelta: null,
      mint: null,
      authority: null,
      feePayer: null,
      acknowledgedAt: null,
      providerResultHash: null,
      manualReviewReason: null,
      releasedAt: null,
      releasedReason: null,
      createdAt: atIso,
      updatedAt: atIso,
    };
    this.proofGates.set(scopeHash, record);
    return record;
  }

  /**
   * The compare-and-set. Single-threaded here, but the CONDITION is what matters and it is the same
   * condition Postgres enforces under a row lock: only an ARMED row may be claimed.
   */
  async claimSolanaProofGate(
    scopeHash: string,
    executionId: string,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null> {
    const prior = this.proofGates.get(scopeHash);
    if (!prior) return null;
    if (prior.state !== "ARMED") return null;
    const claimed: SolanaProofGateRecord = {
      ...prior,
      state: "CLAIMED",
      claimedByExecution: executionId,
      claimedAt: atIso,
      updatedAt: atIso,
    };
    this.proofGates.set(scopeHash, claimed);
    return claimed;
  }

  async recordSolanaProofProgress(
    scopeHash: string,
    progress: SolanaProofProgress,
    state: SolanaProofGateState | null,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null> {
    const prior = this.proofGates.get(scopeHash);
    if (!prior) return null;
    const next: SolanaProofGateRecord = {
      ...prior,
      ...progress,
      state: state ?? prior.state,
      updatedAt: atIso,
    };
    this.proofGates.set(scopeHash, next);
    return next;
  }

  async getSolanaProofGate(scopeHash: string): Promise<SolanaProofGateRecord | null> {
    return this.proofGates.get(scopeHash) ?? null;
  }

  async listSolanaProofGates(limit: number): Promise<readonly SolanaProofGateRecord[]> {
    return [...this.proofGates.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async releaseSolanaProofGatePreSign(
    scopeHash: string,
    reason: string,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null> {
    const prior = this.proofGates.get(scopeHash);
    if (!prior) return null;
    // The record's own evidence decides, not the caller's opinion of how the attempt ended.
    if (!canReleasePreSign(prior).ok) return null;
    const released: SolanaProofGateRecord = {
      ...prior,
      state: "RELEASED_PRE_SIGN",
      releasedAt: atIso,
      releasedReason: reason,
      updatedAt: atIso,
    };
    this.proofGates.set(scopeHash, released);
    return released;
  }

  async getCapability(capabilityId: string): Promise<CapabilityRecord | null> {
    return this.paymentCapabilities.get(capabilityId) ?? null;
  }

  // ── idempotency ────────────────────────────────────────────────────────────

  async claimIdempotency(args: {
    readonly tenantId: string;
    readonly key: string;
    readonly intentId: string;
    readonly action: string;
    readonly requestHash: string;
  }): Promise<string | null> {
    const k = `${args.tenantId}|${args.key}`;
    const existing = this.idempotency.get(k);
    if (existing !== undefined) return existing;
    this.idempotency.set(k, args.intentId);
    return null;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

/**
 * Drop `undefined` members. Load-bearing under `exactOptionalPropertyTypes`: spreading a patch whose
 * optional keys are explicitly `undefined` would overwrite a real value with undefined, which for a
 * settlement amount or a policy hash is silent data loss.
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
