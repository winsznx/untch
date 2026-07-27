/**
 * Consumer Pack HTTP handlers.
 *
 * Same contract as every other handler in this service: `{ status, body }`, the §11 error envelope
 * `{code, message, retryable, docsUrl}`, framework-agnostic so it is unit-testable with the real
 * orchestrator and no network.
 *
 * The shape of every value-moving route is the same, and it is the shape the brief asks for: a call
 * NEVER blocks while a purchase completes. `create`/`quote` return an intent plus a funding request;
 * `purchase` returns 202 with the current state and the two URLs to watch. Execution happens on the
 * worker.
 */

import {
  isProviderError,
  moneyToJson,
  newCorrelationId,
  newIntentId,
  normalizeIdempotencyKey,
  deriveIdempotencyKey,
  sha256Hex,
  stableStringify,
  toErrorEnvelope,
  unknownProviderError,
  type ConsumerActionType,
  type ConsumerIntent,
  type ConsumerQuote,
  type ConsumerReceiptView,
  type ConsumerStore,
} from "@untch/consumer-core";
import type { HandlerResult } from "../handlers";
import type { ConsumerOrchestrator } from "./orchestrator";

export interface ConsumerDeps {
  readonly store: ConsumerStore;
  readonly orchestrator: ConsumerOrchestrator;
  readonly publicBaseUrl: string;
}

function envelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

function fail(err: unknown): HandlerResult {
  const n = isProviderError(err) ? err.normalized : unknownProviderError(err);
  const status =
    n.code === "CAPABILITY_UNAVAILABLE" ? 501
    : n.code === "PROVIDER_NOT_EXECUTABLE" ? 503
    : n.code === "PAUSED" ? 503
    : n.code === "TREASURY_INSUFFICIENT" ? 503
    : n.code === "PROVIDER_BAD_REQUEST" ? 400
    : n.code === "PROVIDER_UNAUTHORIZED" ? 403
    : n.code === "QUOTE_EXPIRED" ? 409
    : n.code === "PROVIDER_RATE_LIMITED" ? 429
    : 502;
  return { status, body: { ...toErrorEnvelope(n), retryable: n.retryable } };
}

function body(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireString(b: Record<string, unknown>, key: string, max = 400): string {
  const v = b[key];
  if (typeof v !== "string" || v.trim() === "" || v.length > max) {
    throw Object.assign(new Error(`${key} is required`), { __field: key });
  }
  return v.trim();
}

/**
 * Tenant identity.
 *
 * The tenant is the POLICY OWNER, not something a caller declares. A policy id is already bound to
 * an owner wallet on-chain, so deriving the tenant from it means a caller cannot claim another
 * tenant's scope by sending a header — which is the whole reason `getIntentForTenant` is the only
 * read a handler uses.
 */
function tenantFor(policyId: string): string {
  return `policy:${policyId}`;
}

function intentView(intent: ConsumerIntent, publicBaseUrl: string): Record<string, unknown> {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    intentId: intent.intentId,
    state: intent.state,
    action: intent.action,
    category: intent.category,
    providerId: intent.providerId,
    policyId: intent.policyId,
    policyVersion: intent.policyVersion,
    approvalRequired: intent.approvalRequired,
    approvalOutcome: intent.approvalOutcome,
    quoteExpiresAt: intent.quoteExpiresAt,
    fundingAmount: intent.fundingAmount === null ? null : moneyToJson(intent.fundingAmount),
    settlementAmount: intent.settlementAmount === null ? null : moneyToJson(intent.settlementAmount),
    fee: intent.untchFee === null ? null : moneyToJson(intent.untchFee),
    spread: intent.spread === null ? null : moneyToJson(intent.spread),
    failureCode: intent.failureCode,
    failureDetail: intent.failureDetail,
    correlationId: intent.correlationId,
    statusUrl: `${base}/consumer/intent/${intent.intentId}`,
    eventsUrl: `${base}/consumer/intent/${intent.intentId}/events`,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

function quoteView(quote: ConsumerQuote): Record<string, unknown> {
  return {
    quoteId: quote.quoteId,
    providerId: quote.providerId,
    providerRef: quote.providerRef,
    summary: quote.summary,
    providerCost: moneyToJson(quote.providerCost),
    untchFee: moneyToJson(quote.untchFee),
    spread: moneyToJson(quote.spread),
    totalUserAmount: moneyToJson(quote.totalUserAmount),
    maxAuthorisedAmount: moneyToJson(quote.maxAuthorisedAmount),
    settlement: {
      recipient: quote.settlementRecipient,
      chain: quote.settlementChain,
      token: quote.settlementAsset.symbol,
    },
    terms: quote.terms,
    quoteHash: quote.quoteHash,
    expiresAt: quote.expiresAt,
  };
}

/**
 * Discovery. Creates the intent, runs the provider search, returns normalised options.
 *
 * Nothing here can move purchase-scale value: discovery is gated to a cents-scale capability and a
 * 402 without one is a typed refusal.
 */
export async function handleConsumerSearch(
  raw: unknown,
  action: ConsumerActionType,
  deps: ConsumerDeps,
): Promise<HandlerResult> {
  const b = body(raw);
  let policyId: string;
  try {
    policyId = requireString(b, "policyId", 80);
  } catch {
    return { status: 400, body: envelope("POLICY_ID_REQUIRED", "`policyId` is required") };
  }
  const tenantId = tenantFor(policyId);
  const request = { ...b };
  delete request.policyId;

  const idempotencyKey =
    normalizeIdempotencyKey(b.idempotencyKey) ??
    deriveIdempotencyKey({ tenantId, action, request });

  try {
    const { intent, replayed } = await deps.orchestrator.createIntent({
      tenantId,
      requestingAgentId: typeof b.agentId === "string" ? b.agentId : "anonymous",
      principalId: typeof b.principalId === "string" ? b.principalId : "anonymous",
      action,
      policyId,
      request,
      idempotencyKey,
      correlationId: newCorrelationId(),
      intentId: newIntentId(),
    });

    if (replayed && intent.state !== "CREATED") {
      return { status: 200, body: { ...intentView(intent, deps.publicBaseUrl), replayed: true } };
    }

    const limit = typeof b.limit === "number" && b.limit > 0 ? Math.min(25, Math.floor(b.limit)) : 10;
    const { intent: advanced, result } = await deps.orchestrator.discover(intent.intentId, limit);

    return {
      status: 200,
      body: {
        ...intentView(advanced, deps.publicBaseUrl),
        discoveryId: result.discoveryId,
        providerId: result.providerId,
        options: result.options.map((o) => ({
          ref: o.providerRef,
          title: o.title,
          description: o.description,
          indicativePrice: o.indicativePrice === null ? null : moneyToJson(o.indicativePrice),
          imageUrl: o.imageUrl,
          attributes: o.attributes,
        })),
        truncated: result.truncated,
        note:
          "Indicative information only. Nothing is bindable until a quote is produced from the " +
          "provider's own price challenge.",
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Quote → policy → (approval) → funding request, in one call.
 *
 * The call is bounded: it produces an offer and a decision, and either asks for money or explains
 * why it will not. It never waits for a human and never executes.
 */
export async function handleConsumerQuote(
  raw: unknown,
  action: ConsumerActionType,
  deps: ConsumerDeps,
): Promise<HandlerResult> {
  const b = body(raw);
  let policyId: string;
  let providerRef: string;
  try {
    policyId = requireString(b, "policyId", 80);
    providerRef = requireString(b, "ref", 2048);
  } catch (err) {
    const field = (err as { __field?: string }).__field ?? "ref";
    return {
      status: 400,
      body: envelope(
        field === "policyId" ? "POLICY_ID_REQUIRED" : "REF_REQUIRED",
        field === "policyId"
          ? "`policyId` is required"
          : "`ref` is required — the provider reference from a search result",
      ),
    };
  }

  const tenantId = tenantFor(policyId);
  const request = { ...b };
  delete request.policyId;

  const idempotencyKey =
    normalizeIdempotencyKey(b.idempotencyKey) ??
    deriveIdempotencyKey({ tenantId, action, request });

  try {
    const { intent, replayed } = await deps.orchestrator.createIntent({
      tenantId,
      requestingAgentId: typeof b.agentId === "string" ? b.agentId : "anonymous",
      principalId: typeof b.principalId === "string" ? b.principalId : "anonymous",
      action,
      policyId,
      request,
      idempotencyKey,
      correlationId: newCorrelationId(),
      intentId: newIntentId(),
    });

    // A replay past the quote stage returns what already exists rather than re-quoting: a second
    // quote would mint a second hash and silently invalidate an approval already in flight.
    if (replayed && intent.state !== "CREATED") {
      const existing = intent.quoteId === null ? null : await deps.store.getQuote(intent.quoteId);
      return {
        status: 200,
        body: {
          ...intentView(intent, deps.publicBaseUrl),
          quote: existing === null ? null : quoteView(existing),
          replayed: true,
        },
      };
    }

    const { quote } = await deps.orchestrator.quote(intent.intentId, providerRef);
    const { intent: decided, decision } = await deps.orchestrator.runPolicy(intent.intentId);

    if (decided.state === "BLOCKED") {
      return {
        status: 200,
        body: {
          ...intentView(decided, deps.publicBaseUrl),
          quote: quoteView(quote),
          decision: decision === null ? null : { decision: decision.decision, reasons: decision.reasons, rules: decision.rules },
          nextAction: "NONE",
        },
      };
    }

    if (decided.state === "AWAITING_APPROVAL") {
      return {
        status: 200,
        body: {
          ...intentView(decided, deps.publicBaseUrl),
          quote: quoteView(quote),
          decision: decision === null ? null : { decision: decision.decision, reasons: decision.reasons, rules: decision.rules },
          nextAction: "AWAIT_APPROVAL",
          note: "An operator must approve this spend. Poll the status URL or subscribe to the event stream.",
        },
      };
    }

    const { intent: awaitingFunding, funding } = await deps.orchestrator.requestFunding(intent.intentId);
    return {
      status: 200,
      body: {
        ...intentView(awaitingFunding, deps.publicBaseUrl),
        quote: quoteView(quote),
        decision: decision === null ? null : { decision: decision.decision, reasons: decision.reasons, rules: decision.rules },
        nextAction: "FUND",
        fundingRequest: {
          url: funding.url,
          method: funding.method,
          amount: moneyToJson(funding.amount),
          expiresAt: funding.expiresAt,
          note:
            "This is the VARIABLE purchase value, separate from the fixed marketplace call fee. Pay " +
            "it with x402; the 402 will quote exactly this amount.",
        },
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Arm execution. Returns 202 immediately — the worker does the work.
 *
 * This is where the brief's "do not keep a long HTTP request open" is actually enforced: the handler
 * queues and returns, and the caller watches the stream.
 */
export async function handleConsumerExecute(raw: unknown, deps: ConsumerDeps): Promise<HandlerResult> {
  const b = body(raw);
  let intentId: string;
  let policyId: string;
  try {
    intentId = requireString(b, "intentId", 64);
    policyId = requireString(b, "policyId", 80);
  } catch {
    return { status: 400, body: envelope("INTENT_ID_REQUIRED", "`intentId` and `policyId` are required") };
  }

  const intent = await deps.store.getIntentForTenant(tenantFor(policyId), intentId);
  if (!intent) {
    return { status: 404, body: envelope("INTENT_NOT_FOUND", `no consumer intent ${intentId} for this policy`) };
  }

  try {
    if (intent.state === "AWAITING_APPROVAL") {
      const resolved = await deps.orchestrator.resolveApproval(intentId);
      if (resolved.state === "AWAITING_APPROVAL") {
        return {
          status: 202,
          body: { ...intentView(resolved, deps.publicBaseUrl), nextAction: "AWAIT_APPROVAL" },
        };
      }
      if (resolved.state === "BLOCKED") {
        return { status: 200, body: { ...intentView(resolved, deps.publicBaseUrl), nextAction: "NONE" } };
      }
    }

    const current = (await deps.store.getIntent(intentId)) ?? intent;
    if (current.state === "APPROVED") {
      const { intent: awaiting, funding } = await deps.orchestrator.requestFunding(intentId);
      return {
        status: 202,
        body: {
          ...intentView(awaiting, deps.publicBaseUrl),
          nextAction: "FUND",
          fundingRequest: {
            url: funding.url,
            method: funding.method,
            amount: moneyToJson(funding.amount),
            expiresAt: funding.expiresAt,
          },
        },
      };
    }
    if (current.state === "AWAITING_FUNDING") {
      return { status: 202, body: { ...intentView(current, deps.publicBaseUrl), nextAction: "FUND" } };
    }
    if (current.state === "FUNDED") {
      const queued = await deps.orchestrator.queueExecution(intentId);
      return {
        status: 202,
        body: {
          ...intentView(queued, deps.publicBaseUrl),
          nextAction: "WATCH",
          note: "Execution is queued. Subscribe to the event stream or poll the status URL.",
        },
      };
    }
    return {
      status: 202,
      body: { ...intentView(current, deps.publicBaseUrl), nextAction: "WATCH" },
    };
  } catch (err) {
    return fail(err);
  }
}

/** Status. Free, tenant-scoped. */
export async function handleConsumerStatus(
  intentId: string,
  policyId: string | null,
  deps: ConsumerDeps,
): Promise<HandlerResult> {
  const intent = policyId === null
    ? await deps.store.getIntent(intentId)
    : await deps.store.getIntentForTenant(tenantFor(policyId), intentId);
  if (!intent) {
    return { status: 404, body: envelope("INTENT_NOT_FOUND", `no consumer intent ${intentId}`) };
  }
  return { status: 200, body: intentView(intent, deps.publicBaseUrl) };
}

/** Payment status: what the user funded and what the provider was paid, as two separate facts. */
export async function handleConsumerPayment(intentId: string, deps: ConsumerDeps): Promise<HandlerResult> {
  const intent = await deps.store.getIntent(intentId);
  if (!intent) return { status: 404, body: envelope("INTENT_NOT_FOUND", `no consumer intent ${intentId}`) };
  const funding = await deps.store.getFunding(intentId);
  const executions = await deps.store.listExecutions(intentId);
  const paid = executions.find((e) => e.state === "PAID" || e.state === "ACKNOWLEDGED") ?? null;
  return {
    status: 200,
    body: {
      intentId,
      state: intent.state,
      userFunding:
        funding === null
          ? null
          : {
              amount: moneyToJson(funding.amount),
              chain: funding.chain,
              txHash: funding.txHash,
              confirmations: funding.confirmations,
              finalized: funding.finalized,
              settledAt: funding.settledAt,
            },
      providerSettlement:
        paid === null
          ? null
          : {
              providerId: paid.providerId,
              amount: paid.settledAmount === null ? null : moneyToJson(paid.settledAmount),
              chain: paid.settlementChain,
              txHash: paid.settlementTxHash,
              reference: paid.providerReference,
            },
      attempts: executions.length,
    },
  };
}

/** Delivery evidence: the merchant's claim and Untch's independent check, never merged. */
export async function handleConsumerDelivery(intentId: string, deps: ConsumerDeps): Promise<HandlerResult> {
  const evidence = await deps.store.getDeliveryEvidence(intentId);
  if (!evidence) {
    return { status: 404, body: envelope("NO_DELIVERY_EVIDENCE", `no delivery evidence for ${intentId} yet`) };
  }
  return {
    status: 200,
    body: {
      intentId,
      providerAttested: evidence.providerAttested,
      untchVerified: evidence.untchVerified,
      evidenceHash: evidence.evidenceHash,
      note:
        "`providerAttested` is the merchant's claim. `untchVerified` is what Untch independently " +
        "confirmed. They are deliberately separate.",
    },
  };
}

/** The full cross-rail receipt. */
export async function handleConsumerReceipt(intentId: string, deps: ConsumerDeps): Promise<HandlerResult> {
  const intent = await deps.store.getIntent(intentId);
  if (!intent) return { status: 404, body: envelope("INTENT_NOT_FOUND", `no consumer intent ${intentId}`) };

  const [funding, executions, evidence, approval, quote, ledgerGroups] = await Promise.all([
    deps.store.getFunding(intentId),
    deps.store.listExecutions(intentId),
    deps.store.getDeliveryEvidence(intentId),
    deps.store.getApproval(intentId),
    intent.quoteId === null ? Promise.resolve(null) : deps.store.getQuote(intent.quoteId),
    deps.store.ledgerGroupsForIntent(intentId),
  ]);

  const paid = executions.find((e) => e.state === "PAID" || e.state === "ACKNOWLEDGED") ?? null;
  const decision = intent.policyDecision as { decision?: string } | null;

  const view: ConsumerReceiptView = {
    intentId,
    action: intent.action,
    state: intent.state,
    userFunding:
      funding === null
        ? null
        : {
            amount: moneyToJson(funding.amount),
            chain: funding.chain,
            txHash: funding.txHash,
            settledAt: funding.settledAt,
          },
    providerSettlement:
      paid === null || paid.settledAmount === null
        ? null
        : {
            providerId: paid.providerId,
            amount: moneyToJson(paid.settledAmount),
            chain: paid.settlementChain ?? "",
            recipient: quote?.settlementRecipient ?? "",
            txHash: paid.settlementTxHash,
            reference: paid.providerReference,
          },
    fee: intent.untchFee === null ? null : moneyToJson(intent.untchFee),
    spread: intent.spread === null ? null : moneyToJson(intent.spread),
    policy: {
      policyId: intent.policyId,
      policyVersion: intent.policyVersion,
      policyHash: intent.policyHash,
      decision: decision?.decision ?? null,
    },
    approval: {
      required: intent.approvalRequired,
      outcome: intent.approvalOutcome,
      resolvedBy: approval?.resolvedBy?.channel ?? null,
      resolvedAt: approval?.resolvedAt ?? null,
    },
    delivery: evidence,
    receiptId: intent.receiptId,
    correlationId: intent.correlationId,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };

  return {
    status: 200,
    body: {
      ...view,
      quoteHash: intent.quoteHash,
      spendIntentHash: intent.spendIntentHash,
      ledger: ledgerGroups.map((g) => ({
        groupId: g.groupId,
        kind: g.kind,
        asset: { token: g.asset.symbol, chain: g.asset.chain },
        entries: g.entries.map((e) => ({
          account: e.accountId,
          amount: e.amount.amount.toString(),
          memo: e.memo,
        })),
      })),
      integrity: {
        // A cheap, self-describing digest of what this receipt asserts, so two copies can be
        // compared without diffing prose.
        digest: `0x${sha256Hex(stableStringify(view))}`,
      },
    },
  };
}

/** Notify. Fixed-price, value-moving, and it goes through exactly the same lifecycle as a purchase. */
export async function handleConsumerNotify(
  raw: unknown,
  action: ConsumerActionType,
  deps: ConsumerDeps,
): Promise<HandlerResult> {
  return handleConsumerQuote({ ...body(raw), ref: "send" }, action, deps);
}
