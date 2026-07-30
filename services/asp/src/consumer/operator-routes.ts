/**
 * The authenticated operator control surface for Consumer Intents.
 *
 *   POST /internal/consumer/intents/preflight   — what production WOULD do. Writes nothing.
 *   POST /internal/consumer/intents             — create one intent through the normal path.
 *
 * These are GENERAL operator routes, not a Purch proof route. Nothing here names a provider, a
 * capability, a chain or an amount: the request names them and production decides whether they are
 * allowed, using exactly the controls a paid public request would meet.
 *
 * THE EXECUTION BOUNDARY, WHICH IS THE POINT OF THE WHOLE FILE
 *
 * The create route may reach `ConsumerOrchestrator.createIntent`, `quote`, `runPolicy`,
 * `requestFunding`, `confirmFunding` and `queueExecution`. It may NOT reach `executeIntent`, and it
 * holds no reference that could get there — no adapter, no rail client, no treasury signer, no
 * Solana RPC. The deployed worker's two-second poll over `EXECUTION_QUEUED` is the only thing that
 * executes a provider action, and it stays that way because this file cannot call it.
 *
 * That is not a convention: `services/asp/test/consumer-operator-routes.test.ts` wires an
 * orchestrator whose `executeIntent` throws, and asserts the create route still returns 201.
 *
 * WHAT THE ROUTES REFUSE TO ACCEPT
 *
 * A provider URL, a recipient, a token mint, a chain configuration, a payment rail, a treasury
 * address, or a maturity. All of those are derived from production configuration and the production
 * registry, and supplying one is a 400 rather than a silent override — a controller that believed it
 * pinned a recipient and was quietly overruled would report a guarantee it never had.
 */

import type { Express, Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import {
  IdempotencyConflictError,
  StaleIntentStateError,
  VALUE_MOVING_ACTIONS,
  formatMoney,
  newCorrelationId,
  stableStringify,
  type ConsumerFlags,
} from "@untch/consumer-core";
import type { PolicyProvider } from "@untch/policy-store";
import { authenticateOperator } from "../internal-auth";
import type { DeploymentLifecycle } from "../deployment-info";
import type { ConsumerWiring } from "./wiring";
import {
  parseOperatorIntentInput,
  planOperatorIntent,
  type OperatorDeploymentIdentity,
  type OperatorIntentPlan,
} from "./operator-intent-plan";

export const OPERATOR_PREFLIGHT_ROUTE = "/internal/consumer/intents/preflight" as const;
export const OPERATOR_CREATE_ROUTE = "/internal/consumer/intents" as const;

/**
 * The one read route that had to be ADDED rather than reused.
 *
 * Every public read a controller needs already exists — `/consumer/intent/:id`, `/payment`,
 * `/delivery`, `/receipt`, `/events`, and the public receipt — and all of them are TENANT-scoped
 * behind a SIWE session. Production runs with `CONSUMER_AUTH_REQUIRED=1`, which is correct and
 * deliberately leaves the `?policyId=` fallback closed, so an operator controller holding only
 * `INTERNAL_OPS_TOKEN` cannot read any of them.
 *
 * The alternatives were worse. Giving the controller a SIWE key means giving it a wallet whose
 * signature grants a tenant session; loosening the public reads means weakening a control that
 * protects every tenant so that one operator can watch one intent. So this route consolidates the
 * evidence the controller needs behind the operator credential it already has, and returns the same
 * facts the tenant-scoped routes would — read from the production store, never from a second copy.
 */
export const OPERATOR_READ_ROUTE = "/internal/consumer/intents/:intentId" as const;

/** Bumped when the request or response shape changes. Recorded in provenance, so an intent says which. */
export const OPERATOR_ROUTE_VERSION = "1.0.0" as const;

export interface OperatorRoutesDeps {
  readonly wiring: ConsumerWiring | null;
  readonly policyProvider: PolicyProvider | null;
  readonly lifecycle: DeploymentLifecycle | null;
  readonly flags: ConsumerFlags;
  readonly env?: NodeJS.ProcessEnv;
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly docsUrl: null;
}

function fail(res: Response, status: number, code: string, message: string, retryable = false): void {
  const body: ErrorBody = { code, message, retryable, docsUrl: null };
  res.status(status).json(body);
}

/**
 * Did another writer win?
 *
 * A real Postgres found this before a reviewer did. Two concurrent creates naming one intent id both
 * pass the pre-check, and the database — correctly — lets exactly one through: the loser hits a
 * unique violation on the intents primary key, on the idempotency index, or on the quote hash,
 * depending on how far it got before the winner committed. Uncaught, that surfaced as express's
 * default HTML 500, which is the worst possible answer to "did my intent get created?" — it is
 * unparseable, it names no cause, and it invites a retry that could be the second one.
 *
 * So the loss is CLASSIFIED and reported as a refusal. The database's own message never reaches the
 * caller: it names internal index names, and a controller has no use for them.
 */
function isConcurrencyLoss(err: unknown): boolean {
  if (err instanceof StaleIntentStateError) return true;
  if (err instanceof IdempotencyConflictError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  // 23505 = unique_violation. The only class of constraint the operator path can legitimately lose on.
  return code === "23505";
}

/**
 * Is this process running as production, and can it say so from something it did not choose?
 *
 * `RAILWAY_ENVIRONMENT_NAME` is set by the platform inside the container; it is not a value the
 * deploy script writes, so it cannot survive a failed build the way a hand-set variable can. The
 * explicit `UNTCH_ENVIRONMENT` wins where present, for the integration environments that are not
 * Railway at all.
 *
 * The escape hatch is named for what it does and reported in every response that uses it. An
 * integration test needs a way to exercise these routes off-platform; a local process silently
 * passing itself off as production would be the exact failure this whole boundary exists to prevent,
 * so the override is loud rather than convenient.
 */
export function operatorEnvironmentOf(env: NodeJS.ProcessEnv): {
  readonly environment: string | null;
  readonly isProduction: boolean;
} {
  const explicit = env.UNTCH_ENVIRONMENT?.trim() || null;
  const platform = env.RAILWAY_ENVIRONMENT_NAME?.trim() || env.RAILWAY_ENVIRONMENT?.trim() || null;
  const environment = explicit ?? platform;
  const override = env.UNTCH_OPERATOR_ROUTES_ALLOW_NON_PRODUCTION?.trim();
  const overridden = override === "1" || override?.toLowerCase() === "true";
  return { environment, isProduction: environment === "production" || overridden === true };
}

function deploymentIdentity(deps: OperatorRoutesDeps): OperatorDeploymentIdentity {
  const env = deps.env ?? process.env;
  const snapshot = deps.lifecycle?.snapshot() ?? null;
  const { environment, isProduction } = operatorEnvironmentOf(env);
  return {
    phase: snapshot?.phase ?? "STARTING",
    commit: snapshot?.commit ?? null,
    commitShort: snapshot?.commitShort ?? null,
    attested: snapshot?.attested ?? false,
    deploymentId: snapshot?.railwayDeploymentId ?? null,
    migrationVersion: snapshot?.migrationVersion ?? null,
    environment,
    // A durable store AND a production marker. Either alone is not the fact this claims to be.
    productionStore: isProduction && deps.wiring !== null,
    proofGateSchemaReady: snapshot?.solana.schemaReady ?? false,
  };
}

/**
 * The response body.
 *
 * Built by naming fields IN, exactly as `/internal/deployment-info` does and for the same reason: a
 * deny-list would silently start publishing whatever a later change adds to the plan, and the fields
 * most likely to be added near this code are the ones that must not leave the process.
 */
function redactPlan(plan: OperatorIntentPlan): Record<string, unknown> {
  return {
    accepted: plan.accepted,
    intentId: plan.intentId,
    provider: plan.provider,
    capability: plan.capability,
    action: plan.action,
    productionMaturity: plan.productionMaturity,
    publicMaturity: plan.publicMaturity,
    expectedPolicyPath: plan.expectedPolicyPath,
    expectedSettlement: plan.expectedSettlement,
    maxAuthorisedAmount: plan.maxAuthorisedAmount,
    executionFloor: plan.executionFloor,
    executionControls: plan.executionControls,
    proofGate: plan.proofGate,
    fundingMode: plan.fundingMode,
    idempotency: plan.idempotency,
    deployment: plan.deployment,
    refusals: plan.refusals,
    // Stated rather than implied. A reader of this response must not have to infer it.
    note:
      "This is a plan, not an intent. Nothing was created, reserved, queued or paid, and no signer " +
      "was loaded. The provider recipient is read from the provider's own live payment challenge at " +
      "execution time and is never supplied by an operator.",
  };
}

export function registerConsumerOperatorRoutes(app: Express, deps: OperatorRoutesDeps): void {
  const env = deps.env ?? process.env;

  /**
   * Everything both routes do before they diverge.
   *
   * Authentication comes FIRST, before the body is examined at all. A failed authentication must not
   * be distinguishable by how far it got, and — the property §8 asks for — it must not be able to
   * reserve an intent id by having been attempted.
   */
  const authorised = (
    route: string,
    req: Request,
    res: Response,
  ): { readonly operatorKeyId: string } | null => {
    const auth = authenticateOperator(req, { route, env });
    if (!auth.ok) {
      fail(res, auth.status, auth.code, auth.message, auth.code === "OPS_AUTH_THROTTLED");
      return null;
    }
    return { operatorKeyId: auth.operatorKeyId };
  };

  const requireWiring = (res: Response): ConsumerWiring | null => {
    if (!deps.wiring) {
      fail(
        res,
        503,
        "CONSUMER_PACK_NOT_CONFIGURED",
        "the Consumer Pack is not wired on this instance (DATABASE_URL unset), so there is no " +
          "production store to plan against",
      );
      return null;
    }
    return deps.wiring;
  };

  const requirePolicyProvider = (res: Response): PolicyProvider | null => {
    if (!deps.policyProvider) {
      fail(
        res,
        503,
        "POLICY_STORE_NOT_CONFIGURED",
        "this instance has no policy store, so the expected policy path cannot be verified",
      );
      return null;
    }
    return deps.policyProvider;
  };

  // ── preflight ──────────────────────────────────────────────────────────────
  app.post(OPERATOR_PREFLIGHT_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const auth = authorised(OPERATOR_PREFLIGHT_ROUTE, req, res);
    if (!auth) return;
    const wiring = requireWiring(res);
    if (!wiring) return;
    const policyProvider = requirePolicyProvider(res);
    if (!policyProvider) return;

    const parsed = parseOperatorIntentInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({
        code: "OPERATOR_REQUEST_INVALID",
        message: "the request did not validate",
        refusals: parsed.refusals,
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    planOperatorIntent(parsed.input, {
      store: wiring.store,
      registry: wiring.registry,
      policyProvider,
      flags: deps.flags,
      config: wiring.config,
      deployment: deploymentIdentity(deps),
      env,
    })
      .then((plan) => {
        /**
         * 200 whether or not the plan is acceptable.
         *
         * A refused plan is a SUCCESSFUL preflight — the caller asked what production would do and
         * production answered precisely. Returning 4xx would make "your request was malformed"
         * indistinguishable from "your request was well-formed and production is disarmed", and the
         * second is the answer an operator arming a bounded proof actually needs.
         */
        res.status(200).json(redactPlan(plan));
      })
      .catch(next);
  });

  // ── create ─────────────────────────────────────────────────────────────────
  app.post(OPERATOR_CREATE_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const auth = authorised(OPERATOR_CREATE_ROUTE, req, res);
    if (!auth) return;
    const wiring = requireWiring(res);
    if (!wiring) return;
    const policyProvider = requirePolicyProvider(res);
    if (!policyProvider) return;

    const parsed = parseOperatorIntentInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({
        code: "OPERATOR_REQUEST_INVALID",
        message: "the request did not validate",
        refusals: parsed.refusals,
        retryable: false,
        docsUrl: null,
      });
      return;
    }
    const input = parsed.input;

    (async (): Promise<void> => {
      const deployment = deploymentIdentity(deps);
      const plan = await planOperatorIntent(input, {
        store: wiring.store,
        registry: wiring.registry,
        policyProvider,
        flags: deps.flags,
        config: wiring.config,
        deployment,
        env,
      });

      /**
       * The create route runs the SAME plan and refuses on it.
       *
       * Two code paths that decide executability separately are two code paths that will eventually
       * disagree, and the direction of that disagreement is unknowable in advance. So preflight is
       * not an advisory pre-step here: it is the decision, and create simply declines to act when
       * the decision is no.
       */
      if (!plan.accepted) {
        res.status(409).json({
          code: "OPERATOR_INTENT_REFUSED",
          message: "production refused this intent; nothing was created",
          plan: redactPlan(plan),
          retryable: false,
          docsUrl: null,
        });
        return;
      }

      const policyId = plan.expectedPolicyPath.policyId;
      if (policyId === null) {
        // Unreachable while the plan is accepted, and asserted rather than assumed: the alternative
        // is a `!` that turns a future refactor into an intent created against no policy.
        fail(res, 409, "OPERATOR_INTENT_REFUSED", "the accepted plan named no policy");
        return;
      }

      /**
       * Durable operator provenance, recorded on the creation event.
       *
       * The request HASH rather than the request: the body may carry a delivery address or a message,
       * and an audit record is not a reason to keep a copy of personal data. The operator KEY ID
       * rather than the token: a truncated one-way digest that names which credential acted and
       * cannot be replayed as one. Neither is ever read back as authority.
       */
      const provenance = {
        source: "internal-operator-api",
        route: OPERATOR_CREATE_ROUTE,
        routeVersion: OPERATOR_ROUTE_VERSION,
        operatorKeyId: auth.operatorKeyId,
        requestedAt: new Date().toISOString(),
        requestHash: `0x${createHash("sha256").update(stableStringify({
          intentId: input.intentId,
          tenantId: input.tenantId,
          owner: input.owner,
          provider: input.provider,
          capability: input.capability,
          request: input.request,
          maxProviderAmount: input.maxProviderAmountRaw,
          fundingMode: input.fundingMode,
        })).digest("hex")}`,
        idempotencyKey: input.idempotencyKey,
        servingCommit: deployment.commit,
        servingDeploymentId: deployment.deploymentId,
        environment: deployment.environment,
        controller: req.header("user-agent")?.slice(0, 120) ?? null,
        fundingMode: input.fundingMode,
      } as const;

      const created = await wiring.orchestrator.createIntent({
        intentId: input.intentId,
        tenantId: input.tenantId,
        requestingAgentId: `operator:${auth.operatorKeyId}`,
        principalId: input.owner,
        action: input.capability,
        policyId,
        request: input.request,
        idempotencyKey: input.idempotencyKey,
        correlationId: newCorrelationId(),
        ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt }),
        provenance,
      });

      /**
       * The store enforces the exact id, so a mismatch here means the idempotency record replayed a
       * DIFFERENT intent. That is a refusal, not a success: returning the other intent's id would
       * hand a controller an intent it did not ask for and did not bound.
       */
      if (created.intent.intentId !== input.intentId) {
        res.status(409).json({
          code: "IDEMPOTENCY_KEY_BOUND_ELSEWHERE",
          message: "this idempotency key already names a different intent in this tenant",
          retryable: false,
          docsUrl: null,
        });
        return;
      }

      const base = wiring.publicBaseUrl.replace(/\/+$/, "");
      const view = (state: string, nextAction: string, extra: Record<string, unknown> = {}): void => {
        res.status(created.replayed ? 200 : 201).json({
          intentId: created.intent.intentId,
          state,
          nextAction,
          replayed: created.replayed,
          tenantId: created.intent.tenantId,
          action: created.intent.action,
          provider: input.provider,
          capability: input.capability,
          fundingMode: input.fundingMode,
          maxAuthorisedAmount: plan.maxAuthorisedAmount,
          valueMoving: VALUE_MOVING_ACTIONS.has(input.capability),
          provenanceRecorded: true,
          deployment: plan.deployment,
          statusUrl: `${base}/consumer/intent/${created.intent.intentId}`,
          eventsUrl: `${base}/consumer/intent/${created.intent.intentId}/events`,
          note:
            "Created through the normal orchestrator path: the normal quote, the normal deterministic " +
            "policy, the normal reservation and the normal queue transition. This route holds no " +
            "adapter execution path, no rail client and no signer. The deployed worker is the only " +
            "component that executes a provider action.",
          ...extra,
        });
      };

      /**
       * A replay that already moved past CREATED is returned as it stands.
       *
       * Re-running the chain would mint a second quote and a second hash, silently invalidating an
       * approval already in flight — the same reason the public quote route refuses to re-quote a
       * replay. An operator retrying a request must get back the intent they made, not a new one
       * wearing its id.
       */
      if (created.replayed && created.intent.state !== "CREATED") {
        view(created.intent.state, "NONE", { note: "replayed — this intent already exists and has advanced" });
        return;
      }

      // ── the normal quote ──
      //
      // This DOES reach the provider, over the provider's own unpaid 402 price challenge, exactly as
      // the paid public quote route does. That is what makes the price real rather than asserted. It
      // moves no money and reaches no signer.
      const { quote } = await wiring.orchestrator.quote(created.intent.intentId, input.providerRef);

      // ── the normal deterministic policy ──
      const { intent: decided, decision } = await wiring.orchestrator.runPolicy(created.intent.intentId);
      const decisionView =
        decision === null ? null : { decision: decision.decision, reasons: decision.reasons, rules: decision.rules.length };

      if (decided.state === "BLOCKED" || decided.state === "AWAITING_APPROVAL") {
        view(decided.state, decided.state === "BLOCKED" ? "NONE" : "AWAIT_APPROVAL", {
          decision: decisionView,
          quotedTotal: formatMoney(quote.totalUserAmount),
        });
        return;
      }

      // ── the normal funding request ──
      const { funding } = await wiring.orchestrator.requestFunding(created.intent.intentId);

      /**
       * "Where appropriate" is the whole of the funding-mode distinction.
       *
       * `externally-funded` STOPS here. Somebody other than Untch is paying the funding leg, and they
       * pay it through the x402-priced `/consumer/fund/:intentId` route, which is what records a real
       * settlement. Confirming it here on their behalf would write a funding receipt asserting money
       * arrived when none had.
       *
       * `operator-funded` records Untch as both funder and settler, with a marker that says so
       * plainly rather than a transaction hash that does not exist.
       */
      if (input.fundingMode === "externally-funded") {
        view("AWAITING_FUNDING", "AWAIT_EXTERNAL_FUNDING", {
          decision: decisionView,
          funding: { url: funding.url, amount: formatMoney(funding.amount), expiresAt: funding.expiresAt },
        });
        return;
      }

      const funded = await wiring.orchestrator.confirmFunding(created.intent.intentId, {
        intentId: created.intent.intentId,
        chain: funding.amount.asset.chain,
        txHash: `operator-funded:${created.intent.intentId}`,
        amount: funding.amount,
        payer: `operator:${auth.operatorKeyId}`,
        settledAt: new Date().toISOString(),
        confirmations: 0,
        finalized: false,
      });
      if (funded.state !== "FUNDED") {
        view(funded.state, "NONE", { decision: decisionView });
        return;
      }

      // ── the normal queue transition. The worker takes it from here. ──
      const queued = await wiring.orchestrator.queueExecution(created.intent.intentId);
      view(queued.state, "AWAIT_DEPLOYED_WORKER", {
        decision: decisionView,
        reservation: { amount: formatMoney(funding.amount), mode: "operator-funded" },
        quotedTotal: formatMoney(quote.totalUserAmount),
      });
    })().catch((err: unknown) => {
      if (isConcurrencyLoss(err)) {
        fail(
          res,
          409,
          "OPERATOR_INTENT_CONCURRENT",
          "another request is already creating this intent — exactly one may win, and this one did " +
            "not. Read the intent's status rather than retrying: a retry is how one authorisation " +
            "becomes two.",
        );
        return;
      }
      next(err);
    });
  });

  // ── read ───────────────────────────────────────────────────────────────────
  //
  // Registered AFTER the two POSTs so `/internal/consumer/intents/preflight` can never be captured
  // by the `:intentId` parameter. The methods differ, so express would not confuse them anyway; the
  // ordering is belt-and-braces, and cheap.
  app.get(OPERATOR_READ_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    if (!authorised(OPERATOR_READ_ROUTE, req, res)) return;
    const wiring = requireWiring(res);
    if (!wiring) return;
    const intentId = req.params.intentId ?? "";

    (async (): Promise<void> => {
      const intent = await wiring.store.getIntent(intentId);
      if (!intent) {
        fail(res, 404, "INTENT_NOT_FOUND", `no consumer intent ${intentId} in the production store`);
        return;
      }

      const [funding, executions, delivery, ledgerGroups, events] = await Promise.all([
        wiring.store.getFunding(intentId),
        wiring.store.listExecutions(intentId),
        wiring.store.getDeliveryEvidence(intentId),
        wiring.store.ledgerGroupsForIntent(intentId),
        wiring.store.eventsSince(intentId, 0, 100),
      ]);

      const base = wiring.publicBaseUrl.replace(/\/+$/, "");
      const decision = intent.policyDecision;

      res.status(200).json({
        intentId: intent.intentId,
        tenantId: intent.tenantId,
        state: intent.state,
        action: intent.action,
        providerId: intent.providerId,
        failure: intent.failureCode === null ? null : { code: intent.failureCode, detail: intent.failureDetail },
        policy: {
          policyId: intent.policyId,
          policyVersion: intent.policyVersion,
          // The trace hash a dispute needs. The decision object itself is included verbatim because
          // the §8.2 discipline is that a decision is never reinterpreted, only reported.
          policyHash: intent.policyHash,
          decision: decision === null ? null : decision.decision ?? null,
          reasons: decision === null ? [] : decision.reasons ?? [],
        },
        quote: intent.quoteId === null ? null : {
          quoteId: intent.quoteId,
          quoteHash: intent.quoteHash,
          expiresAt: intent.quoteExpiresAt,
          total: intent.fundingAmount ? formatMoney(intent.fundingAmount) : null,
          providerCost: intent.settlementAmount ? formatMoney(intent.settlementAmount) : null,
          maxAuthorised: intent.maxAuthorisedAmount ? formatMoney(intent.maxAuthorisedAmount) : null,
        },
        reservation: funding === null ? null : {
          present: true,
          amount: formatMoney(funding.amount),
          chain: funding.chain,
          finalized: funding.finalized,
          confirmations: funding.confirmations,
          // The funding marker, not the payer's identity: an operator needs to know WHETHER it
          // settled and under what marker, not who a third party is.
          settlementMarker: funding.txHash.startsWith("operator-funded:") ? "operator-funded" : "on-chain",
        },
        executions: executions.map((e) => ({
          attemptNo: e.attemptNo,
          state: e.state,
          providerReference: e.providerReference,
          settlementChain: e.settlementChain,
          settlementTxHash: e.settlementTxHash,
          settledAmount: e.settledAmount ? formatMoney(e.settledAmount) : null,
          errorCode: e.error?.code ?? null,
        })),
        delivery: delivery === null ? null : {
          providerAttested: delivery.providerAttested.status,
          untchVerified: delivery.untchVerified.verified,
          method: delivery.untchVerified.method,
          evidenceHash: delivery.evidenceHash,
        },
        /**
         * A ledger SUMMARY, not the ledger.
         *
         * Account ids encode internal structure and the entries carry the full double-entry detail.
         * What an operator watching a proof actually needs is: which groups exist, on which asset,
         * and whether each one balances. Anything more is the reconciliation report's job.
         */
        ledger: ledgerGroups.map((g) => ({
          kind: g.kind,
          asset: `${g.asset.symbol}@${g.asset.chain}`,
          entries: g.entries.length,
        })),
        receiptId: intent.receiptId,
        publicReceiptUrl: intent.receiptId === null ? null : `${base}/consumer/receipt/${intent.intentId}`,
        events: events.map((e) => ({ seq: e.seq, name: e.name, state: e.state, at: e.occurredAt })),
        createdAt: intent.createdAt,
        updatedAt: intent.updatedAt,
        deployment: deploymentIdentity(deps),
      });
    })().catch(next);
  });
}
