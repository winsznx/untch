/**
 * Consumer Pack route registration.
 *
 * Kept out of server.ts so the existing ASP surface is untouched: `registerConsumerRoutes` is called
 * once, adds its own paths, and changes nothing about the routes that were already there. If the
 * wiring is null every consumer path answers a 503 with a named reason and the rest of the service
 * behaves exactly as before.
 *
 * The priced-route table below is exported separately because the x402 middleware must be configured
 * BEFORE `express.json()` (an unpaid request has to 402 without its body being parsed), while the
 * handlers must be registered after. server.ts consumes the two halves at the right moments.
 */

import type { Express, Request, Response, NextFunction } from "express";
// `RouteConfig` and `Network` are re-exported from x402-core's /server subpath (x402-express
// re-exports only a subset). Importing the real types rather than casting means a change to the
// middleware's route shape breaks the build here instead of at runtime on a 402.
import type { RouteConfig } from "@okxweb3/x402-core/server";
import type { Network } from "@okxweb3/x402-core/types";
import { publicToolStateFor, toSseFrame, type ConsumerActionType } from "@untch/consumer-core";
import type { HandlerResult } from "../handlers";
import { attachSseStream } from "./dispatcher";
import {
  handleConsumerDelivery,
  handleConsumerExecute,
  handleConsumerNotify,
  handleConsumerPayment,
  handleConsumerQuote,
  handleConsumerReceipt,
  handlePublicConsumerReceipt,
  handleConsumerSearch,
  handleConsumerStatus,
  type ConsumerDeps,
  type ReceiptStatusLike,
} from "./handlers";
import {
  authenticateSiwe,
  describeAuthMode,
  loadConsumerAuthConfig,
  resolveScope,
  type ConsumerAuthConfig,
  type NonceStore,
  type ScopeResolution,
  type SiweVerifier,
} from "./auth";
import type { ConsumerWiring } from "./wiring";
import type { PolicyProvider } from "@untch/policy-store";

/** Everything the two auth routes need. Assembled in server.ts, where the policy store already lives. */
export interface ConsumerAuthRoutesDeps {
  readonly config: ConsumerAuthConfig;
  readonly nonces: NonceStore;
  readonly verifier: SiweVerifier;
  readonly policyProvider: PolicyProvider;
}

// ── route constants ──────────────────────────────────────────────────────────

export const SHOP_SEARCH_ROUTE = "/consumer/shop/search" as const;
export const SHOP_QUOTE_ROUTE = "/consumer/shop/quote" as const;
export const SHOP_PURCHASE_ROUTE = "/consumer/shop/purchase" as const;
export const SHOP_ORDER_ROUTE = "/consumer/shop/order/:intentId" as const;

export const DOMAINS_CHECK_ROUTE = "/consumer/domains/check" as const;
export const DOMAINS_QUOTE_ROUTE = "/consumer/domains/quote" as const;
export const DOMAINS_REGISTER_ROUTE = "/consumer/domains/register" as const;
export const DOMAINS_RENEW_ROUTE = "/consumer/domains/renew" as const;
export const DOMAINS_STATUS_ROUTE = "/consumer/domains/status/:intentId" as const;

export const TRAVEL_SEARCH_ROUTE = "/consumer/travel/search" as const;
export const TRAVEL_COMPARE_ROUTE = "/consumer/travel/compare" as const;
export const TRAVEL_QUOTE_ROUTE = "/consumer/travel/quote" as const;
export const TRAVEL_BOOK_ROUTE = "/consumer/travel/book" as const;
export const TRAVEL_BOOKING_ROUTE = "/consumer/travel/booking/:intentId" as const;

export const GIFTS_QUOTE_ROUTE = "/consumer/gifts/quote" as const;
export const GIFTS_ORDER_ROUTE = "/consumer/gifts/order" as const;
export const GIFTS_STATUS_ROUTE = "/consumer/gifts/status/:intentId" as const;

export const NOTIFY_CONFIRMATION_ROUTE = "/consumer/notify/confirmation" as const;
export const NOTIFY_RECEIPT_ROUTE = "/consumer/notify/receipt" as const;
export const NOTIFY_EXCEPTION_ROUTE = "/consumer/notify/exception" as const;

/**
 * Untch Mail — the consumer-facing email surface.
 *
 * Deliberately NOT folded into `/consumer/notify/*`. Those three routes are Untch mailing the user
 * about their own intent; these are a caller buying an email action. Sharing a path would mean
 * sharing a policy category, and a permission to send a receipt is not a permission to buy a $5
 * subdomain.
 */
export const MAIL_SEND_ROUTE = "/consumer/mail/send" as const;
export const MAIL_INBOX_BUY_ROUTE = "/consumer/mail/inbox/buy" as const;
export const MAIL_INBOX_STATUS_ROUTE = "/consumer/mail/inbox/status" as const;
export const MAIL_INBOX_TOPUP_ROUTE = "/consumer/mail/inbox/topup" as const;
export const MAIL_INBOX_CANCEL_ROUTE = "/consumer/mail/inbox/cancel" as const;
export const MAIL_SUBDOMAIN_BUY_ROUTE = "/consumer/mail/subdomain/buy" as const;
export const MAIL_SUBDOMAIN_STATUS_ROUTE = "/consumer/mail/subdomain/status" as const;
export const MAIL_SUBDOMAIN_SEND_ROUTE = "/consumer/mail/subdomain/send" as const;
export const MAIL_EXECUTE_ROUTE = "/consumer/mail/execute" as const;

export const INTENT_STATUS_ROUTE = "/consumer/intent/:intentId" as const;
export const INTENT_PAYMENT_ROUTE = "/consumer/intent/:intentId/payment" as const;
export const INTENT_DELIVERY_ROUTE = "/consumer/intent/:intentId/delivery" as const;
export const INTENT_RECEIPT_ROUTE = "/consumer/intent/:intentId/receipt" as const;
export const INTENT_EVENTS_ROUTE = "/consumer/intent/:intentId/events" as const;

/**
 * The PUBLIC receipt. Unauthenticated and unscoped BY DESIGN — it is the link a user shares.
 *
 * It is a separate path from `/consumer/intent/:id/receipt` rather than a query flag on it, because
 * the two have opposite defaults: the private one refuses without tenant scope, this one never asks
 * for any. Making publicness a parameter of one route is how a scoping bug turns into a disclosure.
 */
export const PUBLIC_RECEIPT_ROUTE = "/consumer/receipt/:intentId" as const;

/** Ownership proof. Both are free and neither is tenant-scoped — they are how scope is obtained. */
export const AUTH_NONCE_ROUTE = "/consumer/auth/nonce" as const;
export const AUTH_VERIFY_ROUTE = "/consumer/auth/verify" as const;

export const FUND_ROUTE = "/consumer/fund/:intentId" as const;
export const CONSUMER_CATALOG_ROUTE = "/consumer/catalog" as const;

/** Fixed A2MCP call prices — the ORCHESTRATION fee, never the purchase value. */
export const CONSUMER_PRICES = Object.freeze({
  search: "$0.02",
  detail: "$0.01",
  quote: "$0.05",
  execute: "$0.05",
  travelSearch: "$0.03",
  travelCompare: "$0.02",
  notify: "$0.03",
});

/**
 * The priced-route table for the x402 middleware.
 *
 * Two shapes appear here, and the difference is the whole point of the design:
 *   • every route below takes a FIXED price — Untch's orchestration fee;
 *   • `/consumer/fund/:intentId` takes a PRICE FUNCTION, resolved per-intent at request time.
 */
export function consumerPricedRoutes(args: {
  readonly network: Network;
  readonly payTo: string;
  readonly fundingPrice: ConsumerWiring["fundingPrice"] | null;
}): Record<string, RouteConfig> {
  const fixed = (path: string, price: string, description: string): [string, RouteConfig] => [
    `POST ${path}`,
    {
      accepts: { scheme: "exact", network: args.network, payTo: args.payTo, price },
      description,
      mimeType: "application/json",
    },
  ];

  const table: Record<string, RouteConfig> = Object.fromEntries([
    fixed(SHOP_SEARCH_ROUTE, CONSUMER_PRICES.search, "Untch Shop — governed product search"),
    fixed(SHOP_QUOTE_ROUTE, CONSUMER_PRICES.quote, "Untch Shop — bounded purchase quote + policy decision"),
    fixed(SHOP_PURCHASE_ROUTE, CONSUMER_PRICES.execute, "Untch Shop — execute an approved, funded purchase"),
    fixed(DOMAINS_CHECK_ROUTE, CONSUMER_PRICES.search, "Untch Domains — availability and live pricing"),
    fixed(DOMAINS_QUOTE_ROUTE, CONSUMER_PRICES.quote, "Untch Domains — bounded registration quote + policy decision"),
    fixed(DOMAINS_REGISTER_ROUTE, CONSUMER_PRICES.execute, "Untch Domains — register an approved, funded domain"),
    fixed(DOMAINS_RENEW_ROUTE, CONSUMER_PRICES.execute, "Untch Domains — renew an approved, funded domain"),
    fixed(TRAVEL_SEARCH_ROUTE, CONSUMER_PRICES.travelSearch, "Untch Travel — governed flight search"),
    fixed(TRAVEL_COMPARE_ROUTE, CONSUMER_PRICES.travelCompare, "Untch Travel — compare booking options"),
    fixed(TRAVEL_QUOTE_ROUTE, CONSUMER_PRICES.quote, "Untch Travel — bounded booking quote (needs a booking provider)"),
    fixed(TRAVEL_BOOK_ROUTE, CONSUMER_PRICES.execute, "Untch Travel — book an approved, funded itinerary"),
    fixed(GIFTS_QUOTE_ROUTE, CONSUMER_PRICES.quote, "Untch Gifts — merchandise quote + policy decision"),
    fixed(GIFTS_ORDER_ROUTE, CONSUMER_PRICES.execute, "Untch Gifts — order approved, funded merchandise"),
    fixed(NOTIFY_CONFIRMATION_ROUTE, CONSUMER_PRICES.notify, "Untch Consumer Notify — transactional confirmation"),
    fixed(NOTIFY_RECEIPT_ROUTE, CONSUMER_PRICES.notify, "Untch Consumer Notify — receipt"),
    fixed(NOTIFY_EXCEPTION_ROUTE, CONSUMER_PRICES.notify, "Untch Consumer Notify — exception / approval notice"),
    fixed(MAIL_SEND_ROUTE, CONSUMER_PRICES.quote, "Untch Mail — bounded send quote + policy decision"),
    fixed(MAIL_INBOX_BUY_ROUTE, CONSUMER_PRICES.quote, "Untch Mail — bounded inbox purchase quote + policy decision"),
    fixed(MAIL_INBOX_TOPUP_ROUTE, CONSUMER_PRICES.quote, "Untch Mail — bounded inbox top-up quote + policy decision"),
    fixed(MAIL_SUBDOMAIN_BUY_ROUTE, CONSUMER_PRICES.quote, "Untch Mail — bounded subdomain purchase quote + policy decision"),
    fixed(MAIL_SUBDOMAIN_SEND_ROUTE, CONSUMER_PRICES.quote, "Untch Mail — bounded subdomain send quote + policy decision"),
    fixed(MAIL_EXECUTE_ROUTE, CONSUMER_PRICES.execute, "Untch Mail — execute an approved, funded mail action"),
    fixed(MAIL_INBOX_CANCEL_ROUTE, CONSUMER_PRICES.execute, "Untch Mail — cancel an owned inbox for a pro-rata refund"),
    fixed(MAIL_INBOX_STATUS_ROUTE, CONSUMER_PRICES.search, "Untch Mail — read an owned inbox's status"),
    fixed(MAIL_SUBDOMAIN_STATUS_ROUTE, CONSUMER_PRICES.search, "Untch Mail — read an owned subdomain's status"),
  ]);

  if (args.fundingPrice) {
    // The variable-value leg. Registered once, priced per-intent by the function.
    table[`POST ${FUND_ROUTE}`] = {
      accepts: {
        scheme: "exact",
        network: args.network,
        payTo: args.payTo,
        price: args.fundingPrice,
      },
      description:
        "Untch Consumer — fund one Consumer Intent for its EXACT authorised amount. This is the " +
        "variable purchase value, separate from the fixed marketplace call fee.",
      mimeType: "application/json",
    };
  }

  return table;
}

// ── handler registration ─────────────────────────────────────────────────────

function send(res: Response, result: HandlerResult): void {
  res.status(result.status).json(result.body);
}

function unconfigured(): HandlerResult {
  return {
    status: 503,
    body: {
      code: "CONSUMER_PACK_NOT_CONFIGURED",
      message:
        "the Consumer Pack is not wired on this instance (DATABASE_URL unset) — governed consumer " +
        "execution needs a durable store for intents, the ledger and the outbox",
      retryable: false,
      docsUrl: null,
    },
  };
}

export function registerConsumerRoutes(
  app: Express,
  wiring: ConsumerWiring | null,
  /**
   * Reads §7.4 anchor status. Passed in rather than imported so the consumer routes keep no
   * dependency on the receipt-writer package, and so a deployment without a receipt writer degrades
   * to an honest "not recorded" instead of failing the page.
   */
  receiptStatus: ((receiptId: string) => Promise<ReceiptStatusLike | null | "invalid">) | null = null,
  /**
   * Ownership proof. Null means this instance cannot mint sessions at all, and the auth routes
   * answer 503 rather than 404 — "not configured here" is a different fact from "no such route",
   * and a caller debugging a 404 would look for a typo instead of a missing secret.
   */
  auth: ConsumerAuthRoutesDeps | null = null,
): void {
  if (!wiring) {
    for (const path of [
      SHOP_SEARCH_ROUTE, SHOP_QUOTE_ROUTE, SHOP_PURCHASE_ROUTE,
      DOMAINS_CHECK_ROUTE, DOMAINS_QUOTE_ROUTE, DOMAINS_REGISTER_ROUTE, DOMAINS_RENEW_ROUTE,
      TRAVEL_SEARCH_ROUTE, TRAVEL_COMPARE_ROUTE, TRAVEL_QUOTE_ROUTE, TRAVEL_BOOK_ROUTE,
      GIFTS_QUOTE_ROUTE, GIFTS_ORDER_ROUTE,
      NOTIFY_CONFIRMATION_ROUTE, NOTIFY_RECEIPT_ROUTE, NOTIFY_EXCEPTION_ROUTE,
      MAIL_SEND_ROUTE, MAIL_INBOX_BUY_ROUTE, MAIL_INBOX_STATUS_ROUTE, MAIL_INBOX_TOPUP_ROUTE,
      MAIL_INBOX_CANCEL_ROUTE, MAIL_SUBDOMAIN_BUY_ROUTE, MAIL_SUBDOMAIN_STATUS_ROUTE,
      MAIL_SUBDOMAIN_SEND_ROUTE, MAIL_EXECUTE_ROUTE,
      FUND_ROUTE,
    ]) {
      app.post(path, (_req, res) => send(res, unconfigured()));
    }
    for (const path of [
      SHOP_ORDER_ROUTE, DOMAINS_STATUS_ROUTE, TRAVEL_BOOKING_ROUTE, GIFTS_STATUS_ROUTE,
      INTENT_STATUS_ROUTE, INTENT_PAYMENT_ROUTE, INTENT_DELIVERY_ROUTE, INTENT_RECEIPT_ROUTE,
      INTENT_EVENTS_ROUTE, CONSUMER_CATALOG_ROUTE, PUBLIC_RECEIPT_ROUTE,
    ]) {
      app.get(path, (_req, res) => send(res, unconfigured()));
    }
    for (const path of [AUTH_NONCE_ROUTE, AUTH_VERIFY_ROUTE]) {
      app.post(path, (_req, res) => send(res, unconfigured()));
    }
    return;
  }

  // `wiring` is non-null past the guard above, but the narrowing does not survive into the route
  // closures. Bind it once so every handler below sees the narrowed type.
  const w = wiring;
  const deps: ConsumerDeps = {
    store: w.store,
    orchestrator: w.orchestrator,
    publicBaseUrl: w.publicBaseUrl,
  };

  const post = (
    path: string,
    handler: (body: unknown) => Promise<HandlerResult>,
  ): void => {
    app.post(path, (req: Request, res: Response, next: NextFunction) => {
      handler(req.body).then((r) => send(res, r)).catch(next);
    });
  };

  const search = (path: string, action: ConsumerActionType): void =>
    post(path, (b) => handleConsumerSearch(b, action, deps));
  const quote = (path: string, action: ConsumerActionType): void =>
    post(path, (b) => handleConsumerQuote(b, action, deps));
  const notify = (path: string, action: ConsumerActionType): void =>
    post(path, (b) => handleConsumerNotify(b, action, deps));

  search(SHOP_SEARCH_ROUTE, "shop.search");
  // The intent's action is the action it will ULTIMATELY perform, not the route that created it.
  // Stamping "shop.quote" here meant feeBpsFor() found no entry and returned a 0 fee for every
  // purchase, and capabilityFor(action,"execute") resolved to a non-value-moving capability — so the
  // execution gate checked the wrong thing. The quote route creates a PURCHASE intent that has not
  // been funded yet; the same is true of travel.
  quote(SHOP_QUOTE_ROUTE, "shop.purchase");
  post(SHOP_PURCHASE_ROUTE, (b) => handleConsumerExecute(b, deps));

  search(DOMAINS_CHECK_ROUTE, "domains.check");
  quote(DOMAINS_QUOTE_ROUTE, "domains.register");
  post(DOMAINS_REGISTER_ROUTE, (b) => handleConsumerExecute(b, deps));
  quote(DOMAINS_RENEW_ROUTE, "domains.renew");

  search(TRAVEL_SEARCH_ROUTE, "travel.search");
  search(TRAVEL_COMPARE_ROUTE, "travel.compare");
  quote(TRAVEL_QUOTE_ROUTE, "travel.book");
  post(TRAVEL_BOOK_ROUTE, (b) => handleConsumerExecute(b, deps));

  quote(GIFTS_QUOTE_ROUTE, "gifts.order");
  post(GIFTS_ORDER_ROUTE, (b) => handleConsumerExecute(b, deps));

  notify(NOTIFY_CONFIRMATION_ROUTE, "notify.confirmation");
  notify(NOTIFY_RECEIPT_ROUTE, "notify.receipt");
  notify(NOTIFY_EXCEPTION_ROUTE, "notify.exception");

  // ── Untch Mail ─────────────────────────────────────────────────────────────
  //
  // Every paid Mail route QUOTES; none of them settles inline. `/consumer/mail/execute` is the one
  // door that spends, and it takes an intent that has already been quoted, policy-checked and
  // funded — the same shape shop, domains, travel and gifts use, for the same reason: a route that
  // both prices and pays is a route where an approval can be skipped by accident.
  quote(MAIL_SEND_ROUTE, "mail.send");
  quote(MAIL_INBOX_BUY_ROUTE, "mail.inbox.buy");
  quote(MAIL_INBOX_TOPUP_ROUTE, "mail.inbox.topup");
  quote(MAIL_SUBDOMAIN_BUY_ROUTE, "mail.subdomain.buy");
  quote(MAIL_SUBDOMAIN_SEND_ROUTE, "mail.subdomain.send");
  post(MAIL_EXECUTE_ROUTE, (b) => handleConsumerExecute(b, deps));

  // The free, SIWX-authenticated reads. They never reach the funding leg.
  search(MAIL_INBOX_STATUS_ROUTE, "mail.inbox.status");
  search(MAIL_SUBDOMAIN_STATUS_ROUTE, "mail.subdomain.status");
  //
  // `mail.inbox.cancel` changes state and returns a refund, but costs nothing and is SIWX-gated —
  // so it is neither a search nor a purchase. It runs through the execute door, which refuses it
  // until Untch owns an inbox, rather than being quoted at zero and pushed through a funding leg
  // with nothing to fund.
  post(MAIL_INBOX_CANCEL_ROUTE, (b) => handleConsumerExecute(b, deps));

  // ── the funding leg ────────────────────────────────────────────────────────
  // Reaching this handler means the x402 middleware already settled the payment at the price the
  // DynamicPrice function quoted. The handler's only job is to record it.
  app.post(FUND_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const intentId = req.params.intentId ?? "";
    (async (): Promise<HandlerResult> => {
      const intent = await wiring.store.getIntent(intentId);
      if (!intent || intent.fundingAmount === null) {
        return {
          status: 404,
          body: { code: "INTENT_NOT_FOUND", message: `no fundable intent ${intentId}`, retryable: false, docsUrl: null },
        };
      }
      /**
       * The x402 middleware sets `PAYMENT-RESPONSE` on the way OUT, after this handler returns, so
       * it is not readable here. An earlier version read it anyway and, finding nothing, recorded
       * the funding with a fabricated `unsettled:<intentId>` hash and a real-looking `settledAt` —
       * a row that asserts money arrived, carrying an identifier that is unique per intent by
       * construction and therefore defeats the very `(chain, tx_hash)` uniqueness index meant to
       * make double-funding impossible.
       *
       * Reaching this handler DOES mean the middleware settled the payment — an unpaid request is
       * 402'd before it gets here. So the funding is real; what is unknown is its transaction hash.
       * That is recorded honestly: a `pending:` marker, zero confirmations, `finalized: false`. The
       * reconciler resolves the hash from the chain afterwards, and until it does the receipt says
       * "settled, hash not yet known" rather than inventing one.
       */
      const settlement = readSettlement(req);
      const funded = await wiring.orchestrator.confirmFunding(intentId, {
        intentId,
        chain: intent.fundingAmount.asset.chain,
        txHash: settlement.txHash ?? `pending:${intentId}`,
        amount: intent.fundingAmount,
        payer: settlement.payer,
        settledAt: new Date().toISOString(),
        confirmations: settlement.txHash === null ? 0 : 1,
        finalized: settlement.txHash !== null,
      });
      await wiring.orchestrator.queueExecution(intentId).catch(() => undefined);
      return {
        status: 200,
        body: {
          intentId,
          state: funded.state,
          funded: true,
          // Null when the facilitator's hash is not yet known — never a synthesised value.
          settlementTx: settlement.txHash,
          settlementTxPending: settlement.txHash === null,
          statusUrl: `${wiring.publicBaseUrl.replace(/\/+$/, "")}/consumer/intent/${intentId}`,
          eventsUrl: `${wiring.publicBaseUrl.replace(/\/+$/, "")}/consumer/intent/${intentId}/events`,
          note: "Execution is queued. Watch the event stream; this request does not wait for it.",
        },
      };
    })()
      .then((r) => send(res, r))
      .catch(next);
  });

  /**
   * Tenant scope, resolved from a PROOF where one exists.
   *
   * `?policyId=` alone was never authorisation: a policy id is public on-chain data, so the old
   * behaviour handed any caller who read one off the explorer that tenant's intents. A verified
   * bearer always wins; the query parameter survives only while CONSUMER_AUTH_REQUIRED is off, and
   * the boot log says which mode is live.
   */
  const authConfig: ConsumerAuthConfig = auth?.config ?? {
    secret: null,
    domain: "asp.untch.xyz",
    required: false,
  };

  const scopeOf = (req: Request): ScopeResolution =>
    resolveScope(
      {
        authorization: req.header("authorization"),
        queryPolicyId: typeof req.query.policyId === "string" ? req.query.policyId : null,
      },
      authConfig,
      Date.now(),
    );

  const scopeDenied = (r: Extract<ScopeResolution, { kind: "NONE" }>): HandlerResult => ({
    status: r.code === "SCOPE_REQUIRED" ? 400 : 401,
    body: { code: r.code, message: r.reason, retryable: false, docsUrl: null },
  });

  /** Runs `fn` with a resolved policy id, or answers with the reason there is not one. */
  const scoped = (
    req: Request,
    fn: (policyId: string) => Promise<HandlerResult>,
  ): Promise<HandlerResult> => {
    const scope = scopeOf(req);
    return scope.kind === "NONE" ? Promise.resolve(scopeDenied(scope)) : fn(scope.policyId);
  };

  // ── ownership proof (free, and NOT tenant-scoped — this is how scope is obtained) ──────────
  /**
   * The nonce is issued by the SERVER and recorded before it is ever shown.
   *
   * A client-chosen nonce proves nothing: a caller could pre-sign a message and replay it forever.
   * Recording it first is what makes the single-use check in /verify meaningful.
   */
  app.post(AUTH_NONCE_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    if (!auth) {
      send(res, {
        status: 503,
        body: {
          code: "AUTH_NOT_CONFIGURED",
          message: "this instance cannot mint sessions (CONSUMER_AUTH_SECRET unset)",
          retryable: false,
          docsUrl: null,
        },
      });
      return;
    }
    const declared = typeof (req.body as { address?: unknown } | undefined)?.address === "string"
      ? ((req.body as { address: string }).address)
      : null;
    auth.nonces
      .issue(declared, Date.now())
      .then(({ nonce, expiresAt }) => {
        // No caching, ever. A cached nonce is a reusable nonce.
        res.setHeader("Cache-Control", "no-store");
        send(res, {
          status: 200,
          body: {
            nonce,
            expiresAt,
            domain: auth.config.domain,
            statement: "Sign in to Untch to read your governed consumer intents.",
            requiredResources: [
              "untch:policy:<policyId> — REQUIRED. Binds this session to one policy; the signer must be its on-chain owner.",
              "untch:agent:<agentId> — optional. Recorded on the session for audit.",
            ],
            chains: [196, 195],
            note:
              "Sign a SIWE message naming this domain, this nonce and an X Layer chainId, then POST " +
              "{message, signature} to /consumer/auth/verify.",
          },
        });
      })
      .catch(next);
  });

  app.post(AUTH_VERIFY_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    if (!auth) {
      send(res, {
        status: 503,
        body: {
          code: "AUTH_NOT_CONFIGURED",
          message: "this instance cannot mint sessions (CONSUMER_AUTH_SECRET unset)",
          retryable: false,
          docsUrl: null,
        },
      });
      return;
    }
    const b = (req.body ?? {}) as { message?: unknown; signature?: unknown };
    if (typeof b.message !== "string" || typeof b.signature !== "string") {
      send(res, {
        status: 400,
        body: {
          code: "AUTH_BAD_REQUEST",
          message: "both `message` (the SIWE message) and `signature` are required",
          retryable: false,
          docsUrl: null,
        },
      });
      return;
    }
    authenticateSiwe(
      { message: b.message, signature: b.signature as `0x${string}` },
      { config: auth.config, nonces: auth.nonces, verifier: auth.verifier, policyProvider: auth.policyProvider },
    )
      .then((outcome) => {
        res.setHeader("Cache-Control", "no-store");
        if (!outcome.ok) {
          // 401 for a failed proof, 403 for a proof that succeeded but does not entitle. The
          // distinction matters to a caller: one says "sign again", the other says "wrong wallet".
          send(res, {
            status: outcome.code === "NOT_POLICY_OWNER" ? 403 : outcome.code === "AUTH_NOT_CONFIGURED" ? 503 : 401,
            body: { code: outcome.code, message: outcome.reason, retryable: false, docsUrl: null },
          });
          return;
        }
        send(res, {
          status: 200,
          body: {
            token: outcome.token,
            tokenType: "Bearer",
            expiresAt: new Date(outcome.session.expiresAt).toISOString(),
            address: outcome.session.address,
            policyId: outcome.session.policyId,
            agentId: outcome.session.agentId,
            usage: "Send `Authorization: Bearer <token>` on tenant-scoped reads. The SSE stream " +
              "accepts `?token=` because EventSource cannot set headers.",
          },
        });
      })
      .catch(next);
  });

  // ── status surfaces (all free) ─────────────────────────────────────────────
  const statusHandler = (req: Request, res: Response, next: NextFunction): void => {
    scoped(req, (policyId) => handleConsumerStatus(req.params.intentId ?? "", policyId, deps))
      .then((r) => send(res, r))
      .catch(next);
  };
  for (const path of [INTENT_STATUS_ROUTE, SHOP_ORDER_ROUTE, DOMAINS_STATUS_ROUTE, TRAVEL_BOOKING_ROUTE, GIFTS_STATUS_ROUTE]) {
    app.get(path, statusHandler);
  }

  app.get(INTENT_PAYMENT_ROUTE, (req, res, next) => {
    scoped(req, (policyId) => handleConsumerPayment(req.params.intentId ?? "", policyId, deps))
      .then((r) => send(res, r))
      .catch(next);
  });
  app.get(INTENT_DELIVERY_ROUTE, (req, res, next) => {
    scoped(req, (policyId) => handleConsumerDelivery(req.params.intentId ?? "", policyId, deps))
      .then((r) => send(res, r))
      .catch(next);
  });
  app.get(INTENT_RECEIPT_ROUTE, (req, res, next) => {
    scoped(req, (policyId) => handleConsumerReceipt(req.params.intentId ?? "", policyId, deps))
      .then((r) => send(res, r))
      .catch(next);
  });

  // Public and deliberately un-scoped. Cached briefly: a receipt is immutable once anchored, and the
  // pending states change on the order of a batch interval, not a request.
  app.get(PUBLIC_RECEIPT_ROUTE, (req, res, next) => {
    handlePublicConsumerReceipt(req.params.intentId ?? "", deps, receiptStatus)
      .then((r) => {
        res.setHeader("Cache-Control", "public, max-age=15");
        res.setHeader("Access-Control-Allow-Origin", "*");
        send(res, r);
      })
      .catch(next);
  });

  // ── SSE ────────────────────────────────────────────────────────────────────
  app.get(INTENT_EVENTS_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const intentId = req.params.intentId ?? "";
    /**
     * The stream is scoped like every other read, and the stakes here are the highest of the set: an
     * unscoped SSE endpoint hands a caller another tenant's whole lifecycle — amounts, provider,
     * decisions — continuously, which is strictly more than the equivalent GET would have leaked.
     *
     * EventSource cannot set an Authorization header, so a browser client passes the session as
     * `?token=`. That is a real trade-off: the token lands in access logs and Referer headers. It is
     * acceptable only because these sessions live 30 minutes and carry no capability beyond reading
     * one tenant's intents — and it is still strictly better than the policy id, which never
     * expires and is published on chain.
     */
    const scope = resolveScope(
      {
        authorization:
          req.header("authorization") ??
          (typeof req.query.token === "string" ? `Bearer ${req.query.token}` : undefined),
        queryPolicyId: typeof req.query.policyId === "string" ? req.query.policyId : null,
      },
      authConfig,
      Date.now(),
    );
    if (scope.kind === "NONE") {
      send(res, scopeDenied(scope));
      return;
    }
    const policyId = scope.policyId;
    void w.store
      .getIntentForTenant(`policy:${policyId}`, intentId)
      .then((owned) => {
        if (!owned) {
          send(res, {
            status: 404,
            body: { code: "INTENT_NOT_FOUND", message: `no consumer intent ${intentId}`, retryable: false, docsUrl: null },
          });
          return;
        }
        openStream();
      })
      .catch(next);

    function openStream(): void {
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    // Register the disconnect handler BEFORE the await. A client that aborts during replay would
    // otherwise never have its subscriber removed, leaking it for the process's lifetime.
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    req.on("close", () => {
      closed = true;
      unsubscribe?.();
      res.end();
    });

    attachSseStream({
      store: w.store,
      hub: w.hub,
      intentId,
      lastEventId: req.headers["last-event-id"] ?? req.query.lastEventId,
      subscriber: {
        intentId,
        write: (chunk) => res.write(chunk),
        close: () => res.end(),
      },
    })
      .then((unsub) => {
        unsubscribe = unsub;
        // The client may have disconnected while we were replaying from the durable record.
        if (closed) unsub();
      })
      .catch(next);
    }
  });

  // ── catalogue ──────────────────────────────────────────────────────────────
  app.get(CONSUMER_CATALOG_ROUTE, (_req, res, next) => {
    buildConsumerCatalog(wiring).then((b) => res.json(b)).catch(next);
  });
}

/** Read the settled payment out of the x402 `PAYMENT-RESPONSE` the middleware attached. */
function readSettlement(req: Request): { txHash: string | null; payer: string | null } {
  const header = req.res?.getHeader("payment-response");
  if (typeof header !== "string") return { txHash: null, payer: null };
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    return {
      txHash: typeof decoded.transaction === "string" ? decoded.transaction : null,
      payer: typeof decoded.payer === "string" ? decoded.payer : null,
    };
  } catch {
    return { txHash: null, payer: null };
  }
}

/**
 * The public catalogue.
 *
 * Every claim here is derived from durable state — the registry's maturity, the rails a key exists
 * for — rather than from a hand-maintained list. That is what stops the catalogue from advertising a
 * capability the instance cannot actually perform.
 */
export async function buildConsumerCatalog(wiring: ConsumerWiring): Promise<Record<string, unknown>> {
  const providers = await wiring.store.listProviders();
  const withCaps = await Promise.all(
    providers.map(async (p) => ({
      providerId: p.providerId,
      displayName: p.displayName,
      maturity: p.maturity,
      protocol: p.protocol,
      chains: p.chains,
      enabled: p.enabled,
      provenance: p.provenance,
      capabilities: (await wiring.store.listCapabilities(p.providerId)).map((c) => ({
        capability: c.capability,
        maturity: c.maturity,
        /**
         * The public five-state label, derived per TOOL and never assigned per provider.
         *
         * `state` is what a dashboard, a doc page and the OKX.AI registration draft all read, so
         * they cannot drift from each other or from the gate. `accessBlocker` says why, when the
         * reason is something outside Untch — which is the difference between "we haven't finished"
         * and "the merchant won't admit us", and those should never render the same.
         */
        state: publicToolStateFor(p, c),
        accessBlocker: c.accessBlocker ?? null,
        notes: c.notes,
      })),
    })),
  );

  const executable = withCaps.filter((p) => p.maturity === "verified");

  return {
    pack: "Untch Consumer Pack",
    thesis:
      "Any agent can propose a real-world action. Untch decides whether it is authorised, funds it " +
      "for the exact approved amount, pays the merchant on the merchant's own rail, verifies " +
      "delivery, and produces one cross-rail receipt.",
    services: {
      shop: [SHOP_SEARCH_ROUTE, SHOP_QUOTE_ROUTE, SHOP_PURCHASE_ROUTE, SHOP_ORDER_ROUTE],
      domains: [DOMAINS_CHECK_ROUTE, DOMAINS_QUOTE_ROUTE, DOMAINS_REGISTER_ROUTE, DOMAINS_RENEW_ROUTE, DOMAINS_STATUS_ROUTE],
      travel: [TRAVEL_SEARCH_ROUTE, TRAVEL_COMPARE_ROUTE, TRAVEL_QUOTE_ROUTE, TRAVEL_BOOK_ROUTE, TRAVEL_BOOKING_ROUTE],
      gifts: [GIFTS_QUOTE_ROUTE, GIFTS_ORDER_ROUTE, GIFTS_STATUS_ROUTE],
      status: [INTENT_STATUS_ROUTE, INTENT_PAYMENT_ROUTE, INTENT_DELIVERY_ROUTE, INTENT_RECEIPT_ROUTE, INTENT_EVENTS_ROUTE],
      publicReceipt: [PUBLIC_RECEIPT_ROUTE],
      auth: [AUTH_NONCE_ROUTE, AUTH_VERIFY_ROUTE],
      notify: [NOTIFY_CONFIRMATION_ROUTE, NOTIFY_RECEIPT_ROUTE, NOTIFY_EXCEPTION_ROUTE],
      mail: [
        MAIL_SEND_ROUTE, MAIL_INBOX_BUY_ROUTE, MAIL_INBOX_STATUS_ROUTE, MAIL_INBOX_TOPUP_ROUTE,
        MAIL_INBOX_CANCEL_ROUTE, MAIL_SUBDOMAIN_BUY_ROUTE, MAIL_SUBDOMAIN_STATUS_ROUTE,
        MAIL_SUBDOMAIN_SEND_ROUTE, MAIL_EXECUTE_ROUTE,
      ],
    },
    /**
     * Which surfaces need a session, stated in the catalog so a calling agent discovers it here
     * rather than by receiving a 401 it did not expect.
     */
    auth: {
      scheme: "SIWE → Bearer",
      obtain: [AUTH_NONCE_ROUTE, AUTH_VERIFY_ROUTE],
      required: loadConsumerAuthConfig().required,
      scopedRoutes: [
        INTENT_STATUS_ROUTE, INTENT_PAYMENT_ROUTE, INTENT_DELIVERY_ROUTE, INTENT_RECEIPT_ROUTE,
        INTENT_EVENTS_ROUTE, SHOP_ORDER_ROUTE, DOMAINS_STATUS_ROUTE, TRAVEL_BOOKING_ROUTE,
        GIFTS_STATUS_ROUTE,
      ],
      publicRoutes: [PUBLIC_RECEIPT_ROUTE, CONSUMER_CATALOG_ROUTE, AUTH_NONCE_ROUTE, AUTH_VERIFY_ROUTE],
      note:
        "A scoped read is tenant-scoped to the POLICY OWNER. Prove control of the owner wallet by " +
        "signing a SIWE message that names this domain, a nonce from /consumer/auth/nonce, an X " +
        "Layer chainId, and `untch:policy:<policyId>` in Resources. `?policyId=` alone is " +
        "namespacing, not authorisation: a policy id is public on-chain data.",
    },
    funding: {
      route: FUND_ROUTE,
      model:
        "The fixed route price is Untch's orchestration fee. The variable purchase value is funded " +
        "separately, per intent, at the exact authorised amount, via x402 dynamic pricing.",
      chain: "eip155:196",
      token: "USDT0",
    },
    providers: withCaps,
    execution: {
      settlementRailsAvailable: wiring.availableRails,
      sandboxExecutionAllowed: wiring.config.allowSandboxExecution,
      providersExecutableToday: executable.map((p) => p.providerId),
      note:
        executable.length === 0
          ? "NO provider is currently executable. Execution requires maturity 'verified', which " +
            "requires a real observed settlement from an Untch treasury wallet. Discovery and " +
            "quoting are available; every execute route will refuse with a named reason."
          : `${executable.length} provider(s) are verified and executable.`,
    },
  };
}
