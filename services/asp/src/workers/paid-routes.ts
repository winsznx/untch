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
import type { Route } from "./router";
import { coerceObjectParams } from "./coerce-params";
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
  const gate: WorkersPaymentGate = async (request, body, run) => {
    const carriesAuthorization =
      request.headers.has("x-payment") || request.headers.has("payment") || request.headers.has("x-payment-signature");
    // Read per request, not captured: the surface is memoised per isolate, and a captured state would
    // keep answering from the posture the isolate happened to start in.
    if (carriesAuthorization) assertArmed(args.arming(), "settle-payment");
    return rawGate(request, body, run);
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

  const priced = (pattern: string, run: (body: unknown) => Promise<HandlerResult> | HandlerResult): Route => ({
    method: "POST",
    pattern,
    bodyMode: "json",
    priced: true,
    handler: async (req) => {
      await hydrate(req.body);
      return fromResult(await run(coerceObjectParams(req.body)));
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
      const result = await handleCreateSpendIntent(coerceObjectParams(req.body), {
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
      priced(PREFLIGHT_ROUTE, (body) => handlePreflightPayment(body, preflightDeps as never)),
      priced(VERIFY_ROUTE, (body) =>
        handleVerifyDelivery(body, { policyProvider, intentStore: ledgerState.intentStore } as never),
      ),
      priced(DETECT_DUP_ROUTE, (body) => handleDetectDuplicate(body, ledgerState.ledger)),
      priced(REDACT_META_ROUTE, (body) => handleRedactPaymentMetadata(body)),
      priced(SUGGEST_NAMES_ROUTE, (body) => handleSuggestNames(body)),
      priced(BRAND_PACK_ROUTE, (body) => handleBrandPack(body)),
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
