/**
 * The Consumer Intent orchestrator — the lifecycle, and the only place it advances.
 *
 * Read this file as a sequence of gates. Each method moves an intent exactly one step, re-checks
 * everything that could have changed since the last step, and writes its state and its event in a
 * single unit of work. Nothing here is best-effort; a step that cannot prove its preconditions
 * refuses rather than continuing on optimism.
 *
 * Three properties are worth calling out because they are what make the whole thing safe:
 *
 *   • THE APPROVAL IS RE-CHECKED AGAINST THE WORLD, NOT REMEMBERED. Before a provider is paid,
 *     `assertApprovalStillBinds` re-reads the quote hash, the policy version, the policy hash, the
 *     recipient, the chain and the ceiling. A policy edited after a human said yes invalidates that
 *     yes. This is the §27 authority boundary applied to consumer execution.
 *
 *   • EXECUTION IS PREPARED BEFORE IT IS SENT. The `consumer_provider_executions` row is written
 *     while the state is PROVIDER_PAYMENT_PENDING, so a process that dies mid-request leaves
 *     evidence behind. An outcome that vanishes with a process is the one failure the reconciler
 *     cannot fix.
 *
 *   • AMBIGUITY GOES TO A HUMAN. `sideEffectPossible` is the discriminator, not the HTTP status.
 *     Anything that might have reached the merchant lands in MANUAL_REVIEW with the money parked in
 *     a SUSPENSE ledger account, never in a retry.
 */

import {
  addMoney,
  applyBasisPoints,
  asset,
  cmpMoney,
  displayMoney,
  eventForState,
  feeBpsFor,
  fundingGroup,
  gtMoney,
  hashQuote,
  isProviderError,
  money,
  newCapabilityId,
  newQuoteId,
  normalizedError,
  parseMoney,
  policyCategoryFor,
  ProviderError,
  ProviderRegistry,
  recognitionGroup,
  refundGroup,
  settlementGroup,
  SPREAD_BPS,
  StaleIntentStateError,
  suspenseGroup,
  unknownProviderError,
  VALUE_MOVING_ACTIONS,
  type CanonicalQuote,
  type ConsumerActionType,
  type ConsumerIntent,
  type ConsumerQuote,
  type ConsumerStore,
  type DiscoveryResult,
  type ExecutionPolicyConfig,
  type FundingReceipt,
  type FundingRequest,
  type Money,
  type NormalizedProviderError,
  type ProviderExecutionRecord,
  type TransitionEvent,
  type TreasuryRouter,
  moneyToJson,
} from "@untch/consumer-core";
import type { AdapterContext, AdapterRegistry } from "@untch/consumer-providers";
import { redactForLog } from "@untch/consumer-providers";
import type { Decision } from "@untch/policy-engine";
import { evaluateIntentSerialized, type Ledger } from "@untch/policy-engine";
import type { PolicyProvider, StoredPolicy } from "@untch/policy-store";
import { toEnginePolicy } from "@untch/policy-store";
import { randomBytes } from "node:crypto";
import { projectConsumerIntent } from "./projection";

/** How the orchestrator reaches the existing §7.2 escalation pipeline. Narrow on purpose. */
export interface ConsumerEscalationGateway {
  requestApproval(args: {
    readonly intentId: string;
    readonly pollRef: string;
    readonly decision: Decision;
    readonly stored: StoredPolicy;
    readonly amount: Money;
    readonly summary: string;
  }): Promise<{ readonly escalationId: string }>;
  /** PENDING | APPROVED | DENIED, resolved against the durable escalation record. */
  pollApproval(pollRef: string): Promise<"PENDING" | "APPROVED" | "DENIED">;
}

/**
 * The outcome of trying to record a §7.4 receipt.
 *
 * `failed` carries the reason. A receipt that cannot be written must never fail a purchase that has
 * already settled — but the operator has to be able to find out WHY, and an earlier bare `catch {}`
 * meant "no receipt" was indistinguishable from "no receipt writer configured". Both showed up as a
 * null receiptId with nothing to investigate.
 */
export type ReceiptRecordOutcome =
  | { readonly status: "recorded"; readonly receiptId: string }
  | { readonly status: "unconfigured" }
  | { readonly status: "failed"; readonly reason: string };

/** How the orchestrator records a §7.4 receipt for a completed consumer action. */
export interface ConsumerReceiptSink {
  record(args: {
    readonly intent: ConsumerIntent;
    readonly quote: ConsumerQuote;
    readonly decision: Decision;
  }): Promise<ReceiptRecordOutcome>;
}

export interface OrchestratorDeps {
  readonly store: ConsumerStore;
  readonly registry: ProviderRegistry;
  readonly adapters: AdapterRegistry;
  readonly treasury: TreasuryRouter;
  readonly policyProvider: PolicyProvider;
  readonly ledger: Ledger;
  readonly escalation: ConsumerEscalationGateway | null;
  readonly receipts: ConsumerReceiptSink | null;
  readonly config: ExecutionPolicyConfig;
  readonly publicBaseUrl: string;
  readonly siwx: import("@untch/consumer-providers").SiwxSigner | null;
  readonly clock?: () => number;
  readonly log?: (line: string, data?: unknown) => void;
}

export interface CreateIntentRequest {
  readonly tenantId: string;
  readonly requestingAgentId: string;
  readonly principalId: string;
  readonly action: ConsumerActionType;
  readonly policyId: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly intentId: string;
  /**
   * An absolute expiry, which may only SHORTEN the action's normal TTL.
   *
   * A caller that could lengthen it could keep a funded, approved intent reachable by a worker
   * indefinitely, which is the one property the TTL exists to deny. Shortening is always safe, so
   * that is the only direction this is allowed to move.
   */
  readonly expiresAt?: string;
  /**
   * Durable, NON-EXECUTABLE provenance, recorded on the creation event.
   *
   * It answers "who created this, from where, against which deployment" for an intent that did not
   * arrive through a paid public route. Nothing reads it back as authority — it is evidence, and the
   * orchestrator never consults it when deciding anything. Values are scalars so an event payload
   * cannot become a place to smuggle a structure past redaction.
   */
  readonly provenance?: Readonly<Record<string, string | number | boolean | null>>;
}

const FUNDING_ASSET = asset("xlayer.usdt0");

export class ConsumerOrchestrator {
  private readonly d: OrchestratorDeps;
  private readonly clock: () => number;
  private readonly log: (line: string, data?: unknown) => void;

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
    this.clock = deps.clock ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  private ctx(correlationId: string, timeoutMs: number, discoveryPayment: Parameters<typeof Object>[0] = null): AdapterContext {
    return {
      correlationId,
      timeoutMs,
      signableChains: new Set(this.d.treasury.availableRails()),
      siwx: this.d.siwx,
      discoveryPayment: discoveryPayment as AdapterContext["discoveryPayment"],
      clock: this.clock,
    };
  }

  // ── 1. CREATE ───────────────────────────────────────────────────────────────

  /**
   * Create the intent, or return the one an identical earlier request already created.
   *
   * Idempotency is claimed BEFORE the row is written, keyed (tenant, key), so two concurrent
   * identical requests produce one intent and one replay rather than two purchases.
   */
  async createIntent(req: CreateIntentRequest): Promise<{ intent: ConsumerIntent; replayed: boolean }> {
    const existing = await this.d.store.findByIdempotencyKey(req.tenantId, req.idempotencyKey);
    if (existing) return { intent: existing, replayed: true };

    const ttlMs = VALUE_MOVING_ACTIONS.has(req.action)
      ? this.d.config.fundingTtlSec * 1000
      : this.d.config.quoteTtlSec * 1000;

    const defaultExpiry = this.clock() + ttlMs;
    const requestedExpiry = req.expiresAt === undefined ? null : Date.parse(req.expiresAt);
    const expiresAtMs =
      requestedExpiry !== null && Number.isFinite(requestedExpiry) && requestedExpiry < defaultExpiry
        ? requestedExpiry
        : defaultExpiry;

    const { intent } = await this.d.store.createIntent(
      {
        intentId: req.intentId,
        tenantId: req.tenantId,
        requestingAgentId: req.requestingAgentId,
        principalId: req.principalId,
        action: req.action,
        category: req.action.split(".")[0] ?? "shop",
        request: req.request,
        policyId: req.policyId,
        correlationId: req.correlationId,
        idempotencyKey: req.idempotencyKey,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      {
        name: "consumer.intent.created",
        data: {
          action: req.action,
          policyId: req.policyId,
          ...(req.provenance === undefined ? {} : { provenance: req.provenance }),
        },
      },
    );
    return { intent, replayed: false };
  }

  // ── 2. DISCOVER ─────────────────────────────────────────────────────────────

  /**
   * Read a provider's inventory. Discovery may use a provider ABOVE `experimental` — reading commits
   * nothing — but it still pays from a small, separate capability, because these providers charge
   * for reads.
   */
  async discover(
    intentId: string,
    limit: number,
  ): Promise<{ intent: ConsumerIntent; result: DiscoveryResult }> {
    const intent = await this.mustGet(intentId);
    const capability = capabilityFor(intent.action, "discover");
    const candidates = await this.d.registry.providersFor(capability, "experimental");
    if (candidates.length === 0) {
      throw new ProviderError(
        normalizedError(
          "CAPABILITY_UNAVAILABLE",
          `no enabled provider declares '${capability}'`,
        ),
      );
    }

    const chosen = candidates[0];
    if (!chosen) throw new ProviderError(normalizedError("CAPABILITY_UNAVAILABLE", capability));
    const adapter = this.d.adapters.get(chosen.provider.providerId);

    const discoveryCap = await this.mintDiscoveryCapability(intent, chosen.provider.providerId);
    let result: DiscoveryResult;
    try {
      result = await adapter.discover(
        { action: intent.action, params: intent.request, limit },
        this.ctx(intent.correlationId, this.d.config.providerTimeoutMs, discoveryCap),
      );
    } finally {
      await this.releaseDiscoveryCapability(discoveryCap);
    }

    const { intent: advanced } = await this.d.store.transition(
      intentId,
      intent.state,
      "DISCOVERING",
      { providerId: chosen.provider.providerId },
      {
        name: "consumer.discovery.completed",
        data: { providerId: chosen.provider.providerId, options: result.options.length },
      },
    );
    return { intent: advanced, result };
  }

  // ── 3. QUOTE ────────────────────────────────────────────────────────────────

  /**
   * Produce the exact, bindable offer.
   *
   * The provider's cost comes from its own challenge. Untch's fee and the disclosed cross-rail
   * spread are computed on top, both rounded CEIL, and `maxAuthorisedAmount` is the total — so the
   * number a human is asked to approve is the number that leaves their wallet, with nothing hidden
   * behind it.
   */
  async quote(intentId: string, providerRef: string): Promise<{ intent: ConsumerIntent; quote: ConsumerQuote }> {
    const intent = await this.mustGet(intentId);
    const capability = capabilityFor(intent.action, "quote");
    const candidates = await this.d.registry.providersFor(capability, "experimental");
    const chosen =
      candidates.find((c) => c.provider.providerId === intent.providerId) ?? candidates[0];
    if (!chosen) {
      throw new ProviderError(
        normalizedError("CAPABILITY_UNAVAILABLE", `no enabled provider declares '${capability}'`),
      );
    }

    const adapter = this.d.adapters.get(chosen.provider.providerId);
    const discoveryCap = await this.mintDiscoveryCapability(intent, chosen.provider.providerId);
    let providerQuote;
    try {
      providerQuote = await adapter.quote(
        { action: intent.action, intentId, providerRef, params: intent.request },
        this.ctx(intent.correlationId, this.d.config.providerTimeoutMs, discoveryCap),
      );
    } finally {
      // Retire it whether the quote succeeded or threw — an abandoned live capability would block
      // the execution capability for this intent.
      await this.releaseDiscoveryCapability(discoveryCap);
    }

    // The provider's cost is denominated in ITS asset; the user funds in USDT0. The two are both
    // 6-decimal dollar stablecoins, so the notional maps 1:1 and the disclosed spread is what
    // absorbs any movement between the two legs. That assumption is stated here rather than buried:
    // a non-dollar settlement asset would need a real rate and is refused by the allowlist today.
    const providerNotional = money(providerQuote.cost.amount, FUNDING_ASSET);
    const feeBps = feeBpsFor(intent.action);
    const untchFee = applyBasisPoints(providerNotional, feeBps, "CEIL");
    const spread = applyBasisPoints(providerNotional, SPREAD_BPS, "CEIL");
    const total = addMoney(addMoney(providerNotional, untchFee), spread);

    const ceiling = parseMoney(this.d.config.maxSingleExecutionDisplay, FUNDING_ASSET);
    if (gtMoney(total, ceiling)) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `${displayMoney(total)} exceeds the instance's single-execution ceiling of ` +
            `${displayMoney(ceiling)} (CONSUMER_MAX_SINGLE_EXECUTION)`,
        ),
      );
    }

    const expiresAt = new Date(this.clock() + this.d.config.quoteTtlSec * 1000).toISOString();
    const canonical: CanonicalQuote = {
      intentId,
      providerId: providerQuote.providerId,
      providerRef: providerQuote.providerRef,
      providerCost: moneyToJson(providerQuote.cost),
      untchFee: moneyToJson(untchFee),
      spread: moneyToJson(spread),
      totalUserAmount: moneyToJson(total),
      maxAuthorisedAmount: moneyToJson(total),
      settlementRecipient: providerQuote.settlementRecipient,
      settlementChain: providerQuote.settlementChain,
      expiresAt,
      terms: providerQuote.terms,
    };

    const quote: ConsumerQuote = {
      quoteId: newQuoteId(),
      intentId,
      providerId: providerQuote.providerId,
      providerCost: providerQuote.cost,
      untchFee,
      spread,
      totalUserAmount: total,
      maxAuthorisedAmount: total,
      settlementRecipient: providerQuote.settlementRecipient,
      settlementChain: providerQuote.settlementChain,
      settlementAsset: providerQuote.settlementAsset,
      providerRef: providerQuote.providerRef,
      summary: providerQuote.summary,
      terms: providerQuote.terms,
      createdAt: this.now(),
      expiresAt,
      quoteHash: hashQuote(canonical),
    };

    await this.d.store.insertQuote(quote);
    const { intent: advanced } = await this.d.store.transition(
      intentId,
      intent.state,
      "QUOTED",
      {
        providerId: quote.providerId,
        quoteId: quote.quoteId,
        quoteHash: quote.quoteHash,
        quoteExpiresAt: quote.expiresAt,
        fundingAmount: total,
        settlementAmount: providerQuote.cost,
        untchFee,
        spread,
        maxAuthorisedAmount: total,
      },
      {
        name: "consumer.quote.created",
        data: {
          providerId: quote.providerId,
          total: moneyToJson(total),
          fee: moneyToJson(untchFee),
          spread: moneyToJson(spread),
          expiresAt,
        },
      },
    );
    return { intent: advanced, quote };
  }

  // ── 4. POLICY ───────────────────────────────────────────────────────────────

  /**
   * Run the REAL §7.1 engine against the REAL stored policy, and surface its decision verbatim.
   *
   * The decision object is stored exactly as the engine produced it. The orchestrator maps its
   * PREFIX to a state and does not reinterpret a single reason or trace entry — the same discipline
   * `preflight_payment` already keeps.
   */
  async runPolicy(intentId: string): Promise<{ intent: ConsumerIntent; decision: Decision | null }> {
    const intent = await this.mustGet(intentId);
    const quote = await this.mustQuote(intent);
    this.assertQuoteFresh(quote);

    const stored = await this.d.policyProvider.loadStored(intent.policyId);
    if (!stored) {
      // Fail closed (I2): an unknown policy is a BLOCK, never a pass.
      //
      // `decision` is null here, and deliberately so. The engine's own BLOCKED_NO_ACTIVE_POLICY
      // outcome requires a §8.1 intent to have been projected, and projection binds to the stored
      // policy's `policyHash` — which does not exist. Synthesising a decision object would mean
      // fabricating a rule trace for an evaluation that never ran, so the honest answer is "blocked,
      // and no engine decision was produced", which is exactly what a null says.
      //
      // The intent still moves through POLICY_CHECKING on its way to BLOCKED. The state machine
      // refuses QUOTED → BLOCKED, and it is right to: every block must be reachable only from an
      // attempted check, so "blocked" always means "we looked". A missing policy IS a failed check.
      const { intent: checkingNoPolicy } = await this.d.store.transition(
        intentId,
        intent.state,
        "POLICY_CHECKING",
        {},
        { name: "consumer.quote.created", data: { policyId: intent.policyId } },
      );
      const blocked = await this.blockIntent(
        checkingNoPolicy,
        "POLICY_NOT_FOUND",
        `no stored policy with id ${intent.policyId}`,
      );
      return { intent: blocked.intent, decision: null };
    }

    const { intent: checking } = await this.d.store.transition(
      intentId,
      intent.state,
      "POLICY_CHECKING",
      { policyVersion: stored.version, policyHash: stored.policyHash },
      { name: "consumer.quote.created", data: { policyId: intent.policyId } },
    );

    const projected = projectConsumerIntent({
      intent: checking,
      quote,
      stored,
      deadlineSec: BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000)),
    });

    const decision = await evaluateIntentSerialized(
      projected.input,
      toEnginePolicy(stored),
      this.d.ledger,
      { now: this.clock },
    );

    const decisionRecord = decision as unknown as Readonly<Record<string, unknown>>;

    if (decision.decision === "APPROVED") {
      const { intent: approved } = await this.d.store.transition(
        intentId,
        "POLICY_CHECKING",
        "APPROVED",
        {
          policyDecision: decisionRecord,
          spendIntentHash: projected.intentHash,
          approvalRequired: false,
          approvalOutcome: "APPROVED",
        },
        { name: "consumer.policy.approved", data: { decision: decision.decision } },
      );
      return { intent: approved, decision };
    }

    if (decision.decision.startsWith("ESCALATED_")) {
      const pollRef = projected.intentHash;
      const { intent: awaiting } = await this.d.store.transition(
        intentId,
        "POLICY_CHECKING",
        "AWAITING_APPROVAL",
        {
          policyDecision: decisionRecord,
          spendIntentHash: projected.intentHash,
          approvalRequired: true,
          approvalOutcome: "PENDING",
        },
        {
          name: "consumer.approval.required",
          data: { decision: decision.decision, reasons: decision.reasons },
        },
      );

      // The approval binds to EXACTLY what was quoted. Every field here is re-checked before the
      // provider is paid.
      await this.d.store.upsertApproval({
        intentId,
        escalationId: "",
        pollRef,
        required: true,
        outcome: "PENDING",
        quoteHash: quote.quoteHash,
        policyId: stored.id,
        policyVersion: stored.version,
        policyHash: stored.policyHash,
        maxAmount: quote.maxAuthorisedAmount,
        settlementRecipient: quote.settlementRecipient,
        settlementChain: quote.settlementChain,
        providerId: quote.providerId,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: this.now(),
      });

      if (this.d.escalation) {
        const { escalationId } = await this.d.escalation.requestApproval({
          intentId,
          pollRef,
          decision,
          stored,
          amount: quote.maxAuthorisedAmount,
          summary: quote.summary,
        });
        const prior = await this.d.store.getApproval(intentId);
        if (prior) await this.d.store.upsertApproval({ ...prior, escalationId });
      } else {
        // No escalation pipeline wired: the intent legitimately WAITS. It is never auto-approved,
        // because an escalation that nobody can answer is still a withheld spend, not a granted one.
        this.log("[consumer] escalation not wired — intent waits for approval", { intentId });
      }
      return { intent: awaiting, decision };
    }

    const blocked = await this.blockIntent(
      checking,
      decision.decision,
      decision.reasons.join("; "),
      decisionRecord,
      projected.intentHash,
    );
    return { intent: blocked.intent, decision };
  }

  /** Resolve a pending approval from the escalation pipeline. */
  async resolveApproval(intentId: string): Promise<ConsumerIntent> {
    const intent = await this.mustGet(intentId);
    if (intent.state !== "AWAITING_APPROVAL") return intent;
    const approval = await this.d.store.getApproval(intentId);
    if (!approval || !this.d.escalation) return intent;

    const outcome = await this.d.escalation.pollApproval(approval.pollRef);
    if (outcome === "PENDING") return intent;

    await this.d.store.resolveApproval(intentId, outcome, null, this.now());

    if (outcome === "DENIED") {
      const { intent: blocked } = await this.d.store.transition(
        intentId,
        "AWAITING_APPROVAL",
        "BLOCKED",
        { approvalOutcome: "DENIED", failureCode: "APPROVAL_DENIED", failureDetail: "operator denied the spend" },
        { name: "consumer.policy.blocked", data: { reason: "APPROVAL_DENIED" } },
      );
      return blocked;
    }

    const { intent: approved } = await this.d.store.transition(
      intentId,
      "AWAITING_APPROVAL",
      "APPROVED",
      { approvalOutcome: "APPROVED" },
      { name: "consumer.approval.completed", data: { outcome } },
    );
    return approved;
  }

  // ── 5. FUNDING ──────────────────────────────────────────────────────────────

  /**
   * Ask the caller to fund the EXACT authorised amount.
   *
   * This is the variable-value leg, and it is deliberately separate from the fixed ASP call fee. The
   * returned URL is x402-priced by a DynamicPrice that reads this intent, so the caller is charged
   * the exact figure the approval bound — no more, and nothing that could be re-scoped later.
   */
  async requestFunding(intentId: string): Promise<{ intent: ConsumerIntent; funding: FundingRequest }> {
    const intent = await this.mustGet(intentId);
    const quote = await this.mustQuote(intent);
    this.assertQuoteFresh(quote);
    if (intent.fundingAmount === null) {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "the intent has no funding amount"));
    }

    const expiresAt = new Date(this.clock() + this.d.config.fundingTtlSec * 1000).toISOString();
    const funding: FundingRequest = {
      intentId,
      url: `${this.d.publicBaseUrl.replace(/\/+$/, "")}/consumer/fund/${intentId}`,
      method: "POST",
      amount: intent.fundingAmount,
      expiresAt,
    };

    const { intent: advanced } = await this.d.store.transition(
      intentId,
      intent.state,
      "AWAITING_FUNDING",
      { expiresAt },
      {
        name: "consumer.funding.requested",
        data: { amount: moneyToJson(funding.amount), url: funding.url, expiresAt },
      },
    );
    return { intent: advanced, funding };
  }

  /**
   * Record a settled funding payment.
   *
   * Idempotent by BOTH the intent and the on-chain tx: a duplicate webhook, a retried settlement
   * callback, or two workers racing all converge on one credit. The ledger group is written in the
   * same transaction as the receipt, so funding can never exist without its entries.
   */
  async confirmFunding(intentId: string, receipt: FundingReceipt): Promise<ConsumerIntent> {
    const intent = await this.mustGet(intentId);
    if (intent.state === "FUNDED") return intent;
    if (intent.fundingAmount === null) {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "the intent has no funding amount"));
    }
    if (cmpMoney(receipt.amount, intent.fundingAmount) < 0) {
      // Underpayment. The intent stays unfunded; nothing is executed on a partial payment.
      throw new ProviderError(
        normalizedError(
          "PAYMENT_FAILED",
          `funding of ${displayMoney(receipt.amount)} is less than the authorised ` +
            `${displayMoney(intent.fundingAmount)}`,
        ),
      );
    }

    const treasuryRef = "xlayer-usdt0-funding";
    const written = await this.d.store.recordFunding(
      receipt,
      fundingGroup({
        groupId: `lg_${randomBytes(8).toString("hex")}`,
        intentId,
        total: receipt.amount,
        treasuryRef,
        createdAt: this.now(),
      }),
    );
    if (!written) {
      this.log("[consumer] duplicate funding ignored", { intentId });
      return (await this.d.store.getIntent(intentId)) ?? intent;
    }

    const { intent: funded } = await this.d.store.transition(
      intentId,
      "AWAITING_FUNDING",
      "FUNDED",
      {},
      {
        name: "consumer.funding.confirmed",
        data: { amount: moneyToJson(receipt.amount), chain: receipt.chain },
      },
    );
    return funded;
  }

  /** Arm execution. Separated from `executeIntent` so the worker, not the request, does the work. */
  async queueExecution(intentId: string): Promise<ConsumerIntent> {
    const intent = await this.mustGet(intentId);
    if (intent.state === "EXECUTION_QUEUED") return intent;
    const { intent: queued } = await this.d.store.transition(
      intentId,
      "FUNDED",
      "EXECUTION_QUEUED",
      {},
      { name: "consumer.execution.started", data: { providerId: intent.providerId } },
    );
    return queued;
  }

  // ── 6. EXECUTE ──────────────────────────────────────────────────────────────

  /**
   * Pay the provider and record what happened.
   *
   * The ordering is the safety property: gates → capability → state to PROVIDER_PAYMENT_PENDING →
   * execution row written → request sent. Everything before the state change can fail into
   * FAILED_BEFORE_PAYMENT; everything after cannot, because money may have moved.
   */
  async executeIntent(intentId: string): Promise<ConsumerIntent> {
    const intent = await this.mustGet(intentId);
    if (intent.state !== "EXECUTION_QUEUED") return intent;

    const quote = await this.mustQuote(intent);
    const providerId = intent.providerId;
    if (providerId === null) {
      return this.failBeforePayment(intent, "NO_PROVIDER", "the intent has no provider");
    }

    // ── gates, all before any spending authority exists ──
    //
    // Ordered cheapest-and-most-absolute first. The FLAG gate leads because it is the one an
    // operator flips in an incident: if execution is switched off, nothing else about this intent
    // matters and no provider should even be consulted.
    let resolved;
    try {
      this.d.registry.assertFlagsAllow(providerId, quote.settlementChain, quote.settlementAsset);
      this.assertQuoteFresh(quote);
      await this.assertApprovalStillBinds(intent, quote);
      resolved = await this.d.registry.assertExecutable(providerId, capabilityFor(intent.action, "execute"));
      await this.d.registry.assertCircuitClosed(providerId, this.d.config.breakerCooldownMs);
    } catch (err) {
      return this.failBeforePayment(intent, ...codeAndDetail(err));
    }

    if (resolved.sandboxOverride) {
      // Loud, and recorded on the intent, so a receipt can never imply the provider was verified.
      this.log("[consumer] EXECUTING AGAINST A SANDBOX PROVIDER under CONSUMER_ALLOW_SANDBOX_EXECUTION", {
        providerId,
        intentId,
      });
    }

    let capability;
    try {
      capability = await this.d.treasury.issueCapability({
        capabilityId: newCapabilityId(),
        intentId,
        providerId,
        asset: quote.settlementAsset,
        maxAmount: quote.providerCost,
        allowedRecipients: [quote.settlementRecipient],
      });
    } catch (err) {
      return this.failBeforePayment(intent, ...codeAndDetail(err));
    }

    // ── the point of no return ──
    const { intent: pending } = await this.d.store.transition(
      intentId,
      "EXECUTION_QUEUED",
      "PROVIDER_PAYMENT_PENDING",
      {},
      { name: "consumer.execution.started", data: { providerId, sandboxOverride: resolved.sandboxOverride } },
    );

    const attempts = await this.d.store.listExecutions(intentId);
    const attemptNo = attempts.length + 1;
    const idempotencyKey = `untch-${intentId}-${attemptNo === 1 ? "exec" : `exec${attemptNo}`}`;
    const executionId = `ex_${randomBytes(10).toString("hex")}`;

    const record: ProviderExecutionRecord = {
      executionId,
      intentId,
      providerId,
      attemptNo,
      idempotencyKey,
      state: "SENT",
      providerReference: null,
      settlementTxHash: null,
      settlementChain: null,
      settledAmount: null,
      error: null,
      startedAt: this.now(),
      finishedAt: null,
    };
    // Written BEFORE the request leaves. A process that dies now leaves a SENT row for the
    // reconciler; a process that dies without one leaves nothing at all.
    await this.d.store.prepareExecution(record);

    const adapter = this.d.adapters.get(providerId);
    try {
      const execution = await adapter.execute(
        {
          action: intent.action,
          intentId,
          providerRef: quote.providerRef,
          params: intent.request,
          idempotencyKey,
          quote: {
            providerId: quote.providerId,
            providerRef: quote.providerRef,
            cost: quote.providerCost,
            settlementRecipient: quote.settlementRecipient,
            settlementChain: quote.settlementChain,
            settlementAsset: quote.settlementAsset,
            summary: quote.summary,
            terms: quote.terms,
            expiresAt: quote.expiresAt,
          },
        },
        capability,
        this.ctx(intent.correlationId, this.d.config.executeTimeoutMs),
      );

      await this.d.store.updateExecution(executionId, {
        state: "PAID",
        providerReference: execution.providerReference,
        settlementTxHash: execution.settlement.txHash,
        settlementChain: execution.settlement.chain,
        settledAmount: execution.settlement.amount,
        finishedAt: this.now(),
      });
      /**
       * The treasury ref must be the one the ACCOUNT is registered under, not a string derived from
       * the chain.
       *
       * The derived form (`eip155:8453-settlement`) produced a ledger account id that nothing else
       * ever read: `assertWithinLimits` and `reconcile` both key off
       * `TREASURY:<assetKey>:<account.treasuryRef>` — `base-usdc-settlement`. The daily cap was
       * therefore summing an account that was never written, so it always read zero and could never
       * fire, and reconciliation compared the float against an empty ledger position. Resolving the
       * real account makes both controls actually bind.
       */
      const settlementRef = await this.settlementTreasuryRef(quote);
      await this.d.store.recordSettlement(
        executionId,
        settlementGroup({
          groupId: `lg_${randomBytes(8).toString("hex")}`,
          intentId,
          cost: execution.settlement.amount,
          providerId,
          treasuryRef: settlementRef,
          createdAt: this.now(),
        }),
      );

      const { intent: paid } = await this.d.store.transition(
        intentId,
        "PROVIDER_PAYMENT_PENDING",
        "PROVIDER_PAID",
        { settlementAmount: execution.settlement.amount },
        {
          name: "consumer.provider.paid",
          data: {
            providerId,
            amount: moneyToJson(execution.settlement.amount),
            chain: execution.settlement.chain,
          },
        },
      );

      const { intent: acked } = await this.d.store.transition(
        intentId,
        "PROVIDER_PAID",
        "PROVIDER_ACKNOWLEDGED",
        {},
        {
          name: "consumer.provider.acknowledged",
          data: { reference: execution.providerReference, status: execution.providerStatus },
        },
      );

      // Delivery evidence is written now (provider-attested) and re-verified by the worker.
      const evidence = await adapter.verifyDelivery(
        execution,
        this.ctx(intent.correlationId, this.d.config.providerTimeoutMs),
      );
      await this.d.store.upsertDeliveryEvidence({ ...evidence, intentId });

      return acked;
    } catch (err) {
      const normalized = isProviderError(err) ? err.normalized : unknownProviderError(err);
      await this.d.store.updateExecution(executionId, {
        state: normalized.sideEffectPossible ? "AMBIGUOUS" : "FAILED",
        error: normalized,
        finishedAt: this.now(),
      });
      return this.handlePostPaymentFailure(pending, normalized);
    }
  }

  // ── 7. VERIFY + COMPLETE ────────────────────────────────────────────────────

  /** Re-verify delivery independently, then complete and recognise the money. */
  async verifyAndComplete(intentId: string): Promise<ConsumerIntent> {
    let intent = await this.mustGet(intentId);
    if (intent.state === "PROVIDER_ACKNOWLEDGED") {
      const { intent: pendingDelivery } = await this.d.store.transition(
        intentId,
        "PROVIDER_ACKNOWLEDGED",
        "DELIVERY_PENDING",
        {},
        { name: "consumer.provider.acknowledged", data: {} },
      );
      intent = pendingDelivery;
    }
    if (intent.state !== "DELIVERY_PENDING") return intent;

    const evidence = await this.d.store.getDeliveryEvidence(intentId);
    const { intent: verified } = await this.d.store.transition(
      intentId,
      "DELIVERY_PENDING",
      "DELIVERY_VERIFIED",
      {},
      {
        name: "consumer.delivery.verified",
        data: {
          // Never merged: what the merchant asserted and what Untch independently proved are
          // different claims, and a receipt that conflated them would overstate what is known.
          untchVerified: evidence?.untchVerified.verified ?? false,
          method: evidence?.untchVerified.method ?? "NONE",
        },
      },
    );

    return this.complete(verified);
  }

  private async complete(intent: ConsumerIntent): Promise<ConsumerIntent> {
    const quote = await this.mustQuote(intent);
    /**
     * Discharge the obligation. `assertIntentSettled` in the ledger asserts the user obligation
     * lands on exactly zero.
     *
     * `settlementAsset` is passed, not assumed, and it decides whether the remainder is booked as
     * COST_OF_GOODS (same rail — the expense) or CROSS_RAIL_CLEARING (different rail — a position
     * owed to the rail that actually paid, where PROVIDER_SETTLEMENT already recorded the expense).
     * Omitting it is what expensed cross-rail purchases twice.
     */
    await this.d.store.appendLedgerGroup(
      recognitionGroup({
        groupId: `lg_${randomBytes(8).toString("hex")}`,
        intentId: intent.intentId,
        total: quote.totalUserAmount,
        fee: quote.untchFee,
        spread: quote.spread,
        settlementAsset: quote.settlementAsset,
        createdAt: this.now(),
      }),
    );

    /**
     * The receipt is recorded but is NEVER allowed to fail the purchase: the money has moved and the
     * ledger already records it, so refusing to complete here would strand a settled intent. What
     * changed is that a failure is now named rather than swallowed — `receiptStatus` goes onto the
     * completion event, so "no receipt" always comes with a reason an operator can act on.
     */
    const outcome: ReceiptRecordOutcome = !intent.policyDecision
      ? { status: "failed", reason: "intent has no stored policy decision to build a receipt from" }
      : this.d.receipts
        ? await this.d.receipts.record({
            intent,
            quote,
            decision: intent.policyDecision as unknown as Decision,
          })
        : { status: "unconfigured" };

    const receiptId = outcome.status === "recorded" ? outcome.receiptId : null;
    if (outcome.status === "failed") {
      this.d.log?.(`[consumer] receipt NOT recorded for ${intent.intentId}: ${outcome.reason}`);
    }

    const { intent: completed } = await this.d.store.transition(
      intent.intentId,
      "DELIVERY_VERIFIED",
      "COMPLETED",
      receiptId === null ? {} : { receiptId },
      {
        name: "consumer.completed",
        data: {
          receiptId,
          receiptStatus: outcome.status,
          ...(outcome.status === "failed" ? { receiptError: outcome.reason } : {}),
        },
      },
    );
    return completed;
  }

  // ── failure paths ───────────────────────────────────────────────────────────

  private async failBeforePayment(
    intent: ConsumerIntent,
    code: string,
    detail: string,
  ): Promise<ConsumerIntent> {
    const { intent: failed } = await this.d.store.transition(
      intent.intentId,
      intent.state,
      "FAILED_BEFORE_PAYMENT",
      { failureCode: code, failureDetail: detail },
      { name: "consumer.failed", data: { code, detail, beforePayment: true } },
    );
    // Nothing left the treasury, so the user's funding is refundable in full.
    const funding = await this.d.store.getFunding(intent.intentId);
    if (funding) {
      await this.d.store.appendLedgerGroup(
        refundGroup({
          groupId: `lg_${randomBytes(8).toString("hex")}`,
          intentId: intent.intentId,
          amount: funding.amount,
          createdAt: this.now(),
        }),
      );
      const { intent: refunding } = await this.d.store.transition(
        intent.intentId,
        "FAILED_BEFORE_PAYMENT",
        "REFUND_PENDING",
        {},
        { name: "consumer.refund.pending", data: { amount: moneyToJson(funding.amount) } },
      );
      return refunding;
    }
    return failed;
  }

  /**
   * A failure at or after PROVIDER_PAYMENT_PENDING.
   *
   * `sideEffectPossible` — not the HTTP status — decides. If the provider MIGHT have acted, the
   * intent goes to MANUAL_REVIEW with the money parked in SUSPENSE. If it definitely did not, the
   * intent can still fail cleanly, but it fails as FAILED_AFTER_PAYMENT, never as
   * FAILED_BEFORE_PAYMENT, because the state machine forbids that edge.
   */
  private async handlePostPaymentFailure(
    intent: ConsumerIntent,
    error: NormalizedProviderError,
  ): Promise<ConsumerIntent> {
    if (error.sideEffectPossible) {
      const { intent: review } = await this.d.store.transition(
        intent.intentId,
        "PROVIDER_PAYMENT_PENDING",
        "MANUAL_REVIEW",
        { failureCode: error.code, failureDetail: error.message },
        {
          name: "consumer.manual_review.required",
          data: { code: error.code, detail: error.message, reason: "AMBIGUOUS_PROVIDER_OUTCOME" },
        },
      );
      const funding = await this.d.store.getFunding(intent.intentId);
      if (funding) {
        await this.d.store.appendLedgerGroup(
          suspenseGroup({
            groupId: `lg_${randomBytes(8).toString("hex")}`,
            intentId: intent.intentId,
            amount: funding.amount,
            createdAt: this.now(),
          }),
        );
      }
      return review;
    }

    const { intent: failed } = await this.d.store.transition(
      intent.intentId,
      "PROVIDER_PAYMENT_PENDING",
      "FAILED_AFTER_PAYMENT",
      { failureCode: error.code, failureDetail: error.message },
      { name: "consumer.failed", data: { code: error.code, detail: error.message, beforePayment: false } },
    );
    return failed;
  }

  private async blockIntent(
    intent: ConsumerIntent,
    code: string,
    detail: string,
    decision?: Readonly<Record<string, unknown>>,
    spendIntentHash?: string,
  ): Promise<{ intent: ConsumerIntent }> {
    const { intent: blocked } = await this.d.store.transition(
      intent.intentId,
      intent.state,
      "BLOCKED",
      {
        failureCode: code,
        failureDetail: detail,
        ...(decision ? { policyDecision: decision } : {}),
        ...(spendIntentHash ? { spendIntentHash } : {}),
      },
      { name: "consumer.policy.blocked", data: { code, detail } },
    );
    return { intent: blocked };
  }

  // ── sweeps ──────────────────────────────────────────────────────────────────

  /** Expire stale intents. Only pre-execution states are swept; see EXPIRABLE_STATES. */
  async expireStale(limit = 50): Promise<number> {
    const stale = await this.d.store.findExpirable(this.now(), limit);
    let expired = 0;
    for (const intent of stale) {
      try {
        await this.d.store.transition(
          intent.intentId,
          intent.state,
          "EXPIRED",
          { failureCode: "EXPIRED", failureDetail: "the quote or funding window lapsed" },
          { name: "consumer.failed", data: { code: "EXPIRED" } },
        );
        expired += 1;
      } catch (err) {
        // A racing worker already advanced it. Not an error.
        if (!(err instanceof StaleIntentStateError)) throw err;
      }
    }
    return expired;
  }

  /**
   * Resolve executions left SENT/AMBIGUOUS by a crash.
   *
   * It QUERIES the provider's status; it never re-sends. That is the whole discipline: an unknown
   * outcome is resolved by asking, and if asking does not answer, by a human.
   */
  async reconcileAmbiguous(olderThanMs = 120_000, limit = 25): Promise<number> {
    const cutoff = new Date(this.clock() - olderThanMs).toISOString();
    const stuck = await this.d.store.findAmbiguousExecutions(cutoff, limit);
    let resolved = 0;

    for (const record of stuck) {
      const intent = await this.d.store.getIntent(record.intentId);
      if (!intent) continue;
      try {
        const adapter = this.d.adapters.get(record.providerId);
        const status = await adapter.getStatus(
          { providerId: record.providerId, reference: record.providerReference ?? intent.request.domain as string ?? "" },
          this.ctx(intent.correlationId, this.d.config.providerTimeoutMs),
        );
        if (status.state === "FULFILLED" || status.state === "IN_PROGRESS") {
          await this.d.store.updateExecution(record.executionId, {
            state: "ACKNOWLEDGED",
            finishedAt: this.now(),
          });
          resolved += 1;
          continue;
        }
      } catch {
        // Falling through to manual review is the correct outcome — a status query that fails
        // leaves the outcome exactly as unknown as it was.
      }
      if (intent.state === "PROVIDER_PAYMENT_PENDING") {
        await this.handlePostPaymentFailure(
          intent,
          normalizedError(
            "PAYMENT_AMBIGUOUS",
            "an in-flight provider execution could not be resolved by a status query",
          ),
        );
        resolved += 1;
      }
    }
    return resolved;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /**
   * Retire a discovery capability once the read is done, used or not.
   *
   * `consumer_capability_intent_idx` is UNIQUE on intent_id WHERE consumed_at IS NULL — at most one
   * LIVE authority per intent. A discovery capability that is minted, never spent, and never retired
   * would hold that slot and make the execution capability unmintable. Retiring it with a zero spend
   * is the honest record: authority issued, authority not used.
   */
  private async releaseDiscoveryCapability(
    cap: import("@untch/consumer-core").PaymentCapability | null,
  ): Promise<void> {
    if (!cap) return;
    try {
      await this.d.store.consumeCapability(cap.capabilityId, money(0n, cap.asset), this.now());
    } catch {
      // Already consumed by a real payment, or gone. Either way there is nothing to retire.
    }
  }

  /** The registered SETTLEMENT account for a quote's rail. Throws rather than inventing a ref. */
  private async settlementTreasuryRef(quote: ConsumerQuote): Promise<string> {
    const account = await this.d.store.findTreasuryAccount(
      quote.settlementChain,
      quote.settlementAsset.symbol,
      "SETTLEMENT",
    );
    if (!account) {
      throw new ProviderError(
        normalizedError(
          "TREASURY_INSUFFICIENT",
          `no registered SETTLEMENT treasury account for ${quote.settlementAsset.symbol} on ` +
            `${quote.settlementChain} — refusing to book a settlement against an account that does not exist`,
        ),
      );
    }
    return account.treasuryRef;
  }

  private async mustGet(intentId: string): Promise<ConsumerIntent> {
    const intent = await this.d.store.getIntent(intentId);
    if (!intent) {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", `no consumer intent ${intentId}`));
    }
    return intent;
  }

  private async mustQuote(intent: ConsumerIntent): Promise<ConsumerQuote> {
    if (intent.quoteId === null) {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "the intent has no quote"));
    }
    const quote = await this.d.store.getQuote(intent.quoteId);
    if (!quote) {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", `quote ${intent.quoteId} is missing`));
    }
    return quote;
  }

  private assertQuoteFresh(quote: ConsumerQuote): void {
    if (Date.parse(quote.expiresAt) <= this.clock()) {
      throw new ProviderError(
        normalizedError("QUOTE_EXPIRED", `quote ${quote.quoteId} expired at ${quote.expiresAt}`),
      );
    }
  }

  /**
   * The re-check that makes an approval an approval OF SOMETHING, rather than a general permission.
   *
   * Every field a human implicitly agreed to is compared against the world as it is now. A re-quote,
   * a policy edit, a changed payout address, or a raised price each break one of these and the
   * approval no longer applies.
   */
  private async assertApprovalStillBinds(intent: ConsumerIntent, quote: ConsumerQuote): Promise<void> {
    const approval = await this.d.store.getApproval(intent.intentId);
    if (!approval) {
      if (intent.approvalRequired) {
        throw new ProviderError(
          normalizedError("PROVIDER_UNAUTHORIZED", "this intent required approval but has no approval record"),
        );
      }
      return;
    }
    if (approval.outcome !== "APPROVED") {
      throw new ProviderError(
        normalizedError("PROVIDER_UNAUTHORIZED", `approval is ${approval.outcome}, not APPROVED`),
      );
    }
    if (approval.quoteHash !== quote.quoteHash) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          "the quote changed after it was approved — the approval bound a different offer",
        ),
      );
    }
    if (approval.providerId !== quote.providerId) {
      throw new ProviderError(
        normalizedError("PROVIDER_UNAUTHORIZED", "the provider changed after approval"),
      );
    }
    if (approval.settlementRecipient.toLowerCase() !== quote.settlementRecipient.toLowerCase()) {
      throw new ProviderError(
        normalizedError("PROVIDER_UNAUTHORIZED", "the settlement recipient changed after approval"),
      );
    }
    if (approval.settlementChain !== quote.settlementChain) {
      throw new ProviderError(
        normalizedError("PROVIDER_UNAUTHORIZED", "the settlement chain changed after approval"),
      );
    }
    if (gtMoney(quote.maxAuthorisedAmount, approval.maxAmount)) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          `the quote now asks ${displayMoney(quote.maxAuthorisedAmount)}, above the approved ` +
            `${displayMoney(approval.maxAmount)}`,
        ),
      );
    }

    const stored = await this.d.policyProvider.loadStored(intent.policyId);
    if (!stored) {
      throw new ProviderError(normalizedError("PROVIDER_UNAUTHORIZED", "the policy no longer exists"));
    }
    if (stored.version !== approval.policyVersion || stored.policyHash !== approval.policyHash) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          `policy ${intent.policyId} changed after approval (approved v${approval.policyVersion}, ` +
            `now v${stored.version}) — the approval no longer applies`,
        ),
      );
    }
  }

  /** A small, read-only spending authority for the paid discovery/quote calls. */
  private async mintDiscoveryCapability(
    intent: ConsumerIntent,
    providerId: string,
  ): Promise<import("@untch/consumer-core").PaymentCapability | null> {
    const provider = await this.d.store.getProvider(providerId);
    if (!provider) return null;
    const recipients = knownRecipientsFor(providerId);
    if (recipients.length === 0) return null;
    try {
      return await this.d.treasury.issueCapability({
        capabilityId: newCapabilityId(),
        // The REAL intent id. A synthetic `<intentId>:discovery:<rand>` violated
        // consumer_payment_capabilities' foreign key against consumer_intents, so every paid
        // discovery and every paid quote threw against Postgres while passing in memory — the
        // in-memory store has no FK to enforce. `releaseDiscoveryCapability` consumes it afterwards
        // so the "at most one LIVE capability per intent" index stays satisfiable for execution.
        intentId: intent.intentId,
        providerId,
        asset: asset("base.usdc"),
        // Cents-scale. A read must never be able to consume purchase-scale authority.
        maxAmount: parseMoney("1.00", asset("base.usdc")),
        allowedRecipients: recipients,
      });
    } catch (err) {
      this.log("[consumer] discovery capability unavailable", {
        providerId,
        reason: codeAndDetail(err)[1],
      });
      return null;
    }
  }
}

/** The verified payTo addresses, from the live challenges. The discovery allowlist. */
function knownRecipientsFor(providerId: string): readonly string[] {
  switch (providerId) {
    case "stabledomains":
      return ["0xABcb091D90419E1c8AD4818f1B33FC4645501892"];
    case "stableemail":
      return ["0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671"];
    case "stabletravel":
    case "stablemerch":
    case "purch":
      // No Base payTo has been observed for these in a discovery challenge. Rather than allowlist a
      // guess, discovery for them simply has no capability and reports the refusal.
      return [];
    default:
      return [];
  }
}

/**
 * Actions that ARE their own deliverable.
 *
 * A quote is a promise to execute something, so the quote phase gates on the capability that will
 * ultimately run. For a purchase that is a separate `*.quote` capability — pricing a registration is
 * not registering it. But a paid READ has nothing separate to quote: pricing `domains.check` IS
 * `domains.check`, and routing it to `domains.quote` asks the registry for a capability that has
 * nothing to do with the call being made.
 */
const SELF_QUOTING_ACTIONS: ReadonlySet<string> = new Set([
  "domains.check",
  "shop.search",
  "travel.search",
  "travel.compare",
  // Every Mail tool is its own capability at every phase. There is no "search the email catalogue"
  // step to fan out from, and collapsing the family onto one discovery capability would make an
  // inbox status read gate on whatever `mail.send` happens to be — which is the drift the
  // per-tool maturity model exists to prevent.
  "mail.send",
  "mail.inbox.buy",
  "mail.inbox.status",
  "mail.inbox.topup",
  "mail.inbox.cancel",
  "mail.subdomain.buy",
  "mail.subdomain.status",
  "mail.subdomain.send",
]);

/** Map an action to the capability name the registry gates on, per phase. */
export function capabilityFor(action: ConsumerActionType, phase: "discover" | "quote" | "execute"): string {
  const [family] = action.split(".");
  if (phase !== "execute" && SELF_QUOTING_ACTIONS.has(action)) return action;
  if (phase === "discover") {
    return family === "shop" ? "shop.search"
      : family === "domains" ? "domains.check"
      : family === "travel" ? "travel.search"
      : family === "gifts" ? "gifts.quote"
      : action;
  }
  if (phase === "quote") {
    return family === "shop" ? "shop.quote"
      : family === "domains" ? "domains.quote"
      : family === "travel" ? "travel.quote"
      : family === "gifts" ? "gifts.quote"
      : action;
  }
  return action;
}

function codeAndDetail(err: unknown): [string, string] {
  const n = isProviderError(err) ? err.normalized : unknownProviderError(err);
  return [n.code, n.message];
}

/** Exported for the event dispatcher: every event payload is redacted before it leaves. */
export function redactEventData(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactForLog(data) as Readonly<Record<string, unknown>>;
}

export { eventForState, policyCategoryFor, type TransitionEvent };
