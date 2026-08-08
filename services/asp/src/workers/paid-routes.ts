/**
 * The six paid marketplace services on Workers, and the exact line between charging and writing.
 *
 * WHY A 402 IS SAFE WHILE `financiallyArmed` IS FALSE
 *
 * Issuing a payment challenge is not executing a payment. A 402 states a price and a payee and asks
 * the caller to decide; nothing of ours moves, and no row is written. The gates that must stay closed
 * are the ones that follow: settling an authorization, enqueueing a receipt, escalating to a human,
 * anchoring a decision on chain. So the challenge is live and the write paths are simply not wired —
 * `receiptEnqueuer`, `escalationGateway`, `intentRegistry` and `oracleSigner` are absent here rather
 * than present-and-refusing, because a dependency that does not exist cannot be called by mistake.
 *
 * THE CONSEQUENCE, STATED PLAINLY
 *
 * A preflight decision served from this deployment is a real decision against real stored policy, and
 * it does not leave a receipt or an on-chain anchor behind. That is the correct behaviour for a
 * deployment that does not own production writes, and it is why `productionWriter` is reported on
 * every health response — a caller can tell which deployment answered them.
 *
 * WHY THE ROUTE TABLE IS NOT RESTATED
 *
 * `buildPaidRouteTable` is the same function `createSellerApp` calls. Prices, payees, networks and
 * resource bindings therefore cannot differ between the two transports, which matters more here than
 * anywhere else in the port: the caller who discovers a mismatch is the one holding the bill.
 */

import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { assertArmed, type ArmingState } from "./arming";
import type { RouteConfig } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { x402ResourceServer } from "@okxweb3/x402-express";
import { PolicyProvider } from "@untch/policy-store";
import { PgPolicyRepo } from "@untch/policy-store";
import type { Pool } from "@untch/consumer-core";
import {
  BRAND_PACK_ROUTE,
  CREATE_INTENT_ROUTE,
  DETECT_DUP_ROUTE,
  PREFLIGHT_ROUTE,
  REDACT_META_ROUTE,
  SUGGEST_NAMES_ROUTE,
  VERIFY_ROUTE,
} from "../config";
import { handleBrandPack, handleSuggestNames } from "../consumer-handlers";
import type { HandlerResult } from "../handlers";
import { handleCreateSpendIntent, handlePreflightPayment, handleVerifyDelivery } from "../handlers";
import { handleDetectDuplicate, handleRedactPaymentMetadata } from "../s11-handlers";
import { createLedgerState } from "../ledger-state";
import { buildPaidRouteTable } from "../paid-route-table";
import { narrowToDecisionOnly } from "../route-profiles";
import type { Route } from "./router";
import { coerceObjectParams, type ParamSchema } from "./coerce-params";
import {
  looksPublic,
  looksPublicVerify,
  runPublicPreflight,
  runPublicVerify,
  type PublicSurfaceArgs,
} from "./public-surface";
import { SERVICES } from "../registry/services";
import { PgIntentStore } from "./intent-store";
import { recordSale } from "./sales";
import { workersPaymentGate, type WorkersPaymentGate } from "./x402-adapter";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers },
  });

const fromResult = (r: HandlerResult): Response => json(r.body, r.status, { ...(r.headers ?? {}) });

export interface PaidSurfaceArgs {

  readonly payTo: string;
  readonly publicBaseUrl: string;
  readonly okx: { readonly apiKey: string; readonly secretKey: string; readonly passphrase: string };
  readonly facilitatorUrl?: string;
  /**
   * The arming state, consulted before settlement rather than alongside it.
   *
   * `settle-payment` is on the financial deny-list and this path was not asking. That made the gate
   * decorative exactly where it matters most: a deployment could take a buyer's authorization and
   * settle it while reporting `financiallyArmed: false`. Issuing the challenge stays unarmed — a 402
   * moves nothing — but turning an authorization into a transfer does not.
   */
  readonly arming: () => ArmingState;
  /**
   * The account-session secret and the policy registry address.
   *
   * Both are what the PUBLISHED preflight contract needs and the protocol one does not. Optional so a
   * deployment missing either still serves the protocol shape rather than failing to build a route
   * table.
   */
  readonly sessionSecret?: string | undefined;
  readonly registry?: string | undefined;
}

export interface PaidSurface {
  /**
   * Everything below is bound to ONE request's pool.
   *
   * The expensive parts — facilitator client, resource server, route table — are memoised per isolate.
   * The pool is not: a Worker forbids using an I/O object across request contexts, so anything that
   * touches the database has to be created with the pool of the request in flight.
   *
   * An earlier version kept the pool in a module-scope variable that each request overwrote. Sequential
   * traffic never noticed; ten concurrent requests clobbered each other's reference and roughly two in
   * ten did their database work against a pool belonging to a different, possibly finished, request.
   */
  readonly gate: WorkersPaymentGate;
  readonly routesFor: (pool: Pool) => readonly Route[];
  readonly table: Record<string, RouteConfig>;
}

/**
 * The policy read path, and only the read path.
 *
 * `initPolicyWiring` builds a repo, a registry reader and — when an operator key is present — a
 * SIGNER, and runs migrations on the way. A deployment that does not own production writes has no
 * business holding any of those. `PolicyProvider` over `PgPolicyRepo` is what preflight and verify
 * actually read, so it is what gets built, and there is no signer in this module to reach for.
 */
export const policyReader = (pool: Pool): PolicyProvider =>
  new PolicyProvider(new PgPolicyRepo(pool as never));

export function buildPaidSurface(args: PaidSurfaceArgs): PaidSurface {
  const table = buildPaidRouteTable({ payTo: args.payTo, publicBaseUrl: args.publicBaseUrl });

  const facilitator = new OKXFacilitatorClient({
    apiKey: args.okx.apiKey,
    secretKey: args.okx.secretKey,
    passphrase: args.okx.passphrase,
    ...(args.facilitatorUrl ? { baseUrl: args.facilitatorUrl } : {}),
    syncSettle: true,
  } as never);

  const server = new x402ResourceServer(facilitator).register("eip155:196", new ExactEvmScheme());
  /**
   * Every confirmed settlement is written down before the buyer gets their bytes back.
   *
   * Four real sales settled on chain with no record of any kind, which left the seller unable to say
   * what it had sold and the buyer unable to prove a purchase. The hook fires only after the
   * facilitator confirms, so nothing refused or failed can be recorded as revenue.
   */
  const rawGate = workersPaymentGate(table, server);

  /**
   * The arming check sits between the challenge and the settlement.
   *
   * A request with no payment header never reaches it: the SDK answers 402 and returns, which is
   * correct unarmed because a challenge states a price and moves nothing. A request CARRYING an
   * authorization is asking this deployment to convert it into a transfer, and that is the operation
   * the deny-list names. Refusing here rather than inside the SDK keeps the SDK unmodified and puts
   * the posture check where a reader looking for it would expect it.
   */
  /**
   * `onSettled` is forwarded, and its absence here cost two real settlements.
   *
   * This wrapper took THREE parameters and called `rawGate(request, body, run)`. The caller in
   * `index.ts` passes a fourth — the hook that writes the sale down — and it was silently discarded,
   * so `recordSale` was unreachable in production. Two paid calls settled on chain, returned correct
   * results, and left `untch_marketplace_sales` empty.
   *
   * TypeScript could not catch it: a function of three parameters is assignable to a type of four.
   * The adapter's own hook tests passed because they exercised `rawGate` directly, below this wrapper.
   * So the guard is behavioural — `a settled sale survives the arming wrapper` in
   * `x402-workers-adapter.test.ts` calls the gate the way the Worker actually calls it.
   */
  /**
   * The fields a POST must carry for the call to have any chance of succeeding.
   *
   * `allOf` must all be present. `anyOf`, when set, needs at least one. The four single-shape tools
   * take their `allOf` straight from the schema's `required`. `verify_delivery` and `preflight_payment`
   * are dual-shape — a marketplace buyer sends `intentHash` or an inline `intent`, not the account-path
   * `intentId` or the friendly public fields — so a strict schema check would reject a valid protocol
   * call. Their presence rules are stated by hand to cover both shapes.
   */
  const requiredPresence: Record<string, { allOf?: readonly string[]; anyOf?: readonly string[] }> = {
    [SUGGEST_NAMES_ROUTE]: { allOf: ["idea"] },
    [BRAND_PACK_ROUTE]: { allOf: ["idea"] },
    [DETECT_DUP_ROUTE]: { allOf: ["policyId", "taskHash", "endpoint", "paramsHash"] },
    [REDACT_META_ROUTE]: { allOf: ["metadata"] },
    [VERIFY_ROUTE]: { anyOf: ["intentId", "intentHash", "intent"] },
    [PREFLIGHT_ROUTE]: { allOf: ["policyId"], anyOf: ["provider", "intent"] },
  };

  /** Does a value satisfy a JSON Schema `type`? Only the types our tools declare. */
  const typeMatches = (value: unknown, want: string): boolean => {
    switch (want) {
      case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array": return Array.isArray(value);
      case "string": return typeof value === "string";
      case "number":
      case "integer": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      default: return true; // an undeclared or unknown type is not something to reject on
    }
  };

  const schema400 = (message: string): Response =>
    new Response(
      JSON.stringify(
        {
          code: "REQUEST_SCHEMA_VIOLATION",
          message: `${message}. Refused before payment, so nothing was charged.`,
          retryable: false,
          docsUrl: null,
        },
        null,
        2,
      ),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } },
    );

  /**
   * The 400 a doomed request gets BEFORE it is asked to pay.
   *
   * An empty `{}`, a body of junk keys, or a field of the WRONG TYPE used to receive a 402, so a buyer
   * could prepare, sign and submit a payment for a call the handler was always going to refuse. Two
   * checks run here, both before the challenge and both charging nothing:
   *
   *   • PRESENCE — the `requiredPresence` rules above, which keep the dual-shape tools honest.
   *   • TYPE — every present field the schema names a type for must match it, checked AFTER the same
   *     coercion the handler applies. `redact_payment_metadata` declares `metadata` an object, and its
   *     own refused example sends `"ada@example.com"` — a string. Presence alone let that reach a 402;
   *     the type check turns it into the 400 the example expects. A JSON-object STRING still passes,
   *     because coercion parses it first, so a CLI buyer who sent `--param metadata={...}` is fine.
   *
   * Only POST bodies are checked. The GET and HEAD compatibility probes carry no body and must still
   * answer the priced 402 that proves the endpoint is real.
   */
  const preGateRefusal = (request: Request, body: unknown): Response | null => {
    if (request.method !== "POST") return null;
    const pathname = new URL(request.url).pathname;
    const rule = requiredPresence[pathname];
    if (!rule) return null;

    // The same schema-driven coercion the handler will apply, so a JSON-string object is judged as the
    // object it will become, not the string it arrived as.
    const svc = SERVICES.find((s) => s.path === pathname && s.method === "POST");
    const b = (coerceObjectParams(body, svc?.input as never) ?? {}) as Record<string, unknown>;

    const has = (k: string) => b[k] !== undefined && b[k] !== null && b[k] !== "";
    const missingAll = (rule.allOf ?? []).filter((k) => !has(k));
    const anyOfUnmet = rule.anyOf && rule.anyOf.length > 0 && !rule.anyOf.some(has);

    const parts: string[] = [];
    if (missingAll.length > 0) parts.push(`missing required field(s): ${missingAll.join(", ")}`);
    if (anyOfUnmet) parts.push(`provide at least one of: ${rule.anyOf!.join(", ")}`);
    if (parts.length > 0) return schema400(parts.join("; "));

    // Presence is satisfied. Now the type of the fields that GATE the call — the ones named in the
    // presence rule — not every optional field, so a lenient handler's tolerance for an odd optional
    // is not overridden here. This is exactly where the reviewer's case lives: `metadata` is required
    // and declared an object, and a string for it makes the call impossible.
    const props = (svc?.input as { properties?: Record<string, { type?: string }> } | undefined)?.properties ?? {};
    const gating = [...(rule.allOf ?? []), ...(rule.anyOf ?? [])];
    const typeErrors: string[] = [];
    for (const key of gating) {
      const value = b[key];
      const want = props[key]?.type;
      if (!want || value === undefined || value === null) continue;
      if (!typeMatches(value, want)) typeErrors.push(`${key} must be ${want === "integer" ? "an integer" : `a ${want}`}`);
    }
    if (typeErrors.length > 0) return schema400(typeErrors.join("; "));

    return null;
  };

  const gate: WorkersPaymentGate = async (request, body, run, onSettled) => {
    // Refuse a call that cannot succeed BEFORE issuing the 402, so no one pays for an empty body.
    const refusal = preGateRefusal(request, body);
    if (refusal) return refusal;

    const carriesAuthorization =
      request.headers.has("x-payment") || request.headers.has("payment") || request.headers.has("x-payment-signature");
    // Read per request, not captured: the surface is memoised per isolate, and a captured state would
    // keep answering from the posture the isolate happened to start in.
    if (carriesAuthorization) assertArmed(args.arming(), "settle-payment");
    return rawGate(request, body, run, onSettled);
  };


  /**
   * In-memory, exactly as Express builds it per process.
   *
   * The ledger and intent store here are request-scoped working state for a decision, not the durable
   * record — that lives in Postgres and is written by whichever deployment owns production writes.
   * An isolate holding its own is the same shape Express has, not a divergence.
   */
  const ledgerState = createLedgerState();

  /**
   * Built per request, because everything in here touches the pool.
   *
   * The policy reader, the durable intent store and the hydration bridge all perform I/O, and a Worker
   * forbids reusing an I/O object across request contexts. The facilitator client, resource server and
   * route table above are isolate state and stay memoised; this is the line between them.
   */
  const routesFor = (pool: Pool): readonly Route[] => {
    const policyProvider = policyReader(pool);
    const intents = new PgIntentStore(pool);

    /**
     * Deliberately missing: `receiptEnqueuer`, `escalationGateway`, `intentRegistry`, `oracleSigner`.
     *
     * Each is a WRITE — a durable receipt, a message to a human, an on-chain anchor, a signed oracle
     * attestation. Railway owns those until the writer transfer. Omitted rather than stubbed so there is
     * nothing here to accidentally call.
     */
    /**
     * The published surface's dependencies, built per request because every one touches the pool.
     *
     * `sessionSecret` and the registry address are what a public preflight needs beyond the policy
     * reader: the first to open the caller's account session, the second to name the chain and
     * registry in the decision snapshot. Absent either, the public branch is not offered and the
     * protocol handler answers as before — a wrong decision is worse than a refused one.
     */
    const publicArgs: PublicSurfaceArgs | null =
      args.sessionSecret && args.registry
        ? { pool, policies: policyProvider, sessionSecret: args.sessionSecret, registry: args.registry }
        : null;

    /**
     * DECISION-ONLY, enforced by the type and re-checked at runtime.
     *
     * `narrowToDecisionOnly` refuses if an execution key is present anyway, so this route cannot reach
     * an executor however the bundle above is later edited.
     */
    const decisionOnly = narrowToDecisionOnly({
      policyProvider,
      intentStore: ledgerState.intentStore,
      scoreDataSource: null,
    } as never);

    const preflightDeps = {
      policyProvider,
      ledger: ledgerState.ledger,
      intentStore: ledgerState.intentStore,
      intentRegistry: null,
      oracleSigner: null,
      scoreDataSource: null,
    };



    /**
     * Bridge the durable store to the in-memory one the canonical handlers take.
     *
     * `resolveIntent` and `resolveIntentForVerify` read the store synchronously and are typed against
     * `InMemoryIntentStore` concretely. Making them async would mean editing the engine that decides
     * whether money may move, to solve a storage problem — the wrong place to take that risk. Instead the
     * intent is loaded from Postgres BEFORE the handler runs and written back AFTER, so the handler sees
     * exactly the store it expects and the durability lives out here.
     */
    const hydrate = async (body: unknown): Promise<void> => {
      const hash = (body as Record<string, unknown> | null)?.intentHash;
      if (typeof hash !== "string") return;
      const stored = await intents.get(hash);
      if (stored) ledgerState.intentStore.put(hash as `0x${string}`, stored as never);
    };

    /** Persist whatever the handler just created, so the next request finds it on another isolate. */
    const persist = async (body: unknown, result: HandlerResult): Promise<void> => {
      const hash = (result.body as Record<string, unknown> | undefined)?.intentHash;
      if (typeof hash !== "string") return;
      const stored = ledgerState.intentStore.get(hash);
      if (stored) await intents.put(hash, stored);
    };

    /**
     * The GET and HEAD compatibility probes on a POST-only business route.
     *
     * Marketplace validators probe a listed endpoint with GET or HEAD to check it is alive. Express registers these
     * and prices them — the shared route table already carries `GET` and `HEAD` entries for each — so a
     * probe gets a 402 proving the endpoint is real and priced, and only a PAID probe reaches the 405.
     *
     * They were left to the 503 fallback while the paid surface could not settle, which was right at
     * the time: a 402 this deployment could not honour would have invited payment for nothing. Now that
     * it settles, Express's answer is the honest one.
     *
     * The GET executes no business logic. Query parameters are not an acceptable transport for a
     * SpendIntent — proxies and access logs keep them — so real calls stay POST-only on both transports.
     */
    const probe = (method: "GET" | "HEAD", pattern: string): Route => ({
      method,
      pattern,
      bodyMode: "none",
      priced: true,
      handler: () =>
        json(
          {
            code: "USE_POST",
            message: "this endpoint is POST-only; GET is accepted only as a paid compatibility probe",
            retryable: false,
            docsUrl: null,
          },
          405,
        ),
    });

  /**
   * The tool's own declared input shape, looked up by route.
   *
   * `--param` can only produce strings, so a contract's `boolean` or `number` arrives as text and is
   * dropped by a handler checking `typeof`. Handing the schema to the coercion is what turns that from
   * a guess into honouring what we published.
   */
  const schemaFor = (pattern: string): ParamSchema | undefined =>
    SERVICES.find((svc) => svc.path === pattern)?.input as ParamSchema | undefined;

  /**
   * Same as `priced`, but the handler also sees the request.
   *
   * The published preflight needs the account session bearer and the payment authorization the gate
   * has already verified. Both live on headers, and neither is a capability: the authorization is
   * parsed down to strings and nulls before it reaches application code.
   */
  const pricedWithRequest = (
    pattern: string,
    run: (body: unknown, request: Request) => Promise<HandlerResult> | HandlerResult,
  ): Route => ({
    method: "POST",
    pattern,
    bodyMode: "json",
    priced: true,
    handler: async (req) => {
      await hydrate(req.body);
      return fromResult(await run(coerceObjectParams(req.body, schemaFor(pattern)), req.request));
    },
  });

  const priced = (pattern: string, run: (body: unknown) => Promise<HandlerResult> | HandlerResult): Route => ({
    method: "POST",
    pattern,
    bodyMode: "json",
    priced: true,
    handler: async (req) => {
      await hydrate(req.body);
      return fromResult(await run(coerceObjectParams(req.body, schemaFor(pattern))));
    },
  });

  /**
   * The free prerequisite, served here because it shares the paid routes' wiring.
   *
   * It was never ported, and two of the six paid services depend on it — an independent buyer found
   * `preflight_payment` and `verify_delivery` unusable because the intent they need could not be
   * created. It is free, so it carries no `priced` flag and never reaches the payment gate; what makes
   * it belong in this module is the policy provider and the intent store, not a price.
   */
  const freeIntent: Route = {
    method: "POST",
    pattern: CREATE_INTENT_ROUTE,
    bodyMode: "json",
    handler: async (req) => {
      const result = await handleCreateSpendIntent(coerceObjectParams(req.body, schemaFor(CREATE_INTENT_ROUTE)), {
        intentStore: ledgerState.intentStore,
        policyProvider,
        intentRegistry: null,
      } as never);
      await persist(req.body, result);
      return fromResult(result);
    },
  };

  return [
      freeIntent,
      /**
       * The published contract first, the protocol one as the fallback it is.
       *
       * Express branches on the body shape and the port kept only the second arm, so a buyer sending
       * exactly what we advertise reached a handler demanding an intent struct and got INTENT_REQUIRED.
       * The two shapes cannot be confused — a public request has `provider`, `capability`, `task` and
       * `maxSpend`; a protocol intent has `owner` and `taskHash` — which is what lets one route serve
       * both without a version flag.
       */
      pricedWithRequest(PREFLIGHT_ROUTE, (body, request) =>
        looksPublic(body) && publicArgs
          ? runPublicPreflight(body, request, publicArgs, decisionOnly)
          : handlePreflightPayment(body, preflightDeps as never),
      ),
      pricedWithRequest(VERIFY_ROUTE, (body, request) =>
        looksPublicVerify(body) && publicArgs
          ? runPublicVerify(body, request, publicArgs)
          : handleVerifyDelivery(body, { policyProvider, intentStore: ledgerState.intentStore } as never),
      ),
      priced(DETECT_DUP_ROUTE, (body) => handleDetectDuplicate(body, ledgerState.ledger)),
      priced(REDACT_META_ROUTE, (body) => handleRedactPaymentMetadata(body)),
      priced(SUGGEST_NAMES_ROUTE, (body) => handleSuggestNames(body)),
      priced(BRAND_PACK_ROUTE, (body) => handleBrandPack(body)),
      /**
       * Every LISTED tool, not the three that happened to be written out by hand.
       *
       * The shared table now generates GET, HEAD and POST together for each listed tool, so there is no
       * longer a route whose GET is priced in one place and missing in the other. Before that,
       * `payment quote https://asp.untch.xyz/detect_duplicate` failed on the GET probe while the same
       * command against `preflight_payment` quoted a price — a buyer comparing two listed endpoints saw
       * one working service and one broken one, with nothing to explain the difference.
       */
      ...PAID_PATHS.map((p) => probe("GET", p)),
      /**
       * HEAD as well as GET. The shared table prices both, and a validator that probes with HEAD —
       * the cheaper, more conventional liveness check — would otherwise get a 503 for an endpoint the
       * listing says is live. A HEAD response carries no body by definition, so the 405 is the status
       * and headers alone.
       */
      ...PAID_PATHS.map((p) => probe("HEAD", p)),
    ];
  };

  return { gate, table, routesFor };
}

/** The six paths this module serves. Named once so the Stage table and the tests cannot disagree. */
export const PAID_PATHS = [
  PREFLIGHT_ROUTE,
  VERIFY_ROUTE,
  DETECT_DUP_ROUTE,
  REDACT_META_ROUTE,
  SUGGEST_NAMES_ROUTE,
  BRAND_PACK_ROUTE,
] as const;
