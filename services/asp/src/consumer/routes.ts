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
import { toSseFrame, type ConsumerActionType } from "@untch/consumer-core";
import type { HandlerResult } from "../handlers";
import { attachSseStream } from "./dispatcher";
import {
  handleConsumerDelivery,
  handleConsumerExecute,
  handleConsumerNotify,
  handleConsumerPayment,
  handleConsumerQuote,
  handleConsumerReceipt,
  handleConsumerSearch,
  handleConsumerStatus,
  type ConsumerDeps,
} from "./handlers";
import type { ConsumerWiring } from "./wiring";

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

export const INTENT_STATUS_ROUTE = "/consumer/intent/:intentId" as const;
export const INTENT_PAYMENT_ROUTE = "/consumer/intent/:intentId/payment" as const;
export const INTENT_DELIVERY_ROUTE = "/consumer/intent/:intentId/delivery" as const;
export const INTENT_RECEIPT_ROUTE = "/consumer/intent/:intentId/receipt" as const;
export const INTENT_EVENTS_ROUTE = "/consumer/intent/:intentId/events" as const;

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

export function registerConsumerRoutes(app: Express, wiring: ConsumerWiring | null): void {
  if (!wiring) {
    for (const path of [
      SHOP_SEARCH_ROUTE, SHOP_QUOTE_ROUTE, SHOP_PURCHASE_ROUTE,
      DOMAINS_CHECK_ROUTE, DOMAINS_QUOTE_ROUTE, DOMAINS_REGISTER_ROUTE, DOMAINS_RENEW_ROUTE,
      TRAVEL_SEARCH_ROUTE, TRAVEL_COMPARE_ROUTE, TRAVEL_QUOTE_ROUTE, TRAVEL_BOOK_ROUTE,
      GIFTS_QUOTE_ROUTE, GIFTS_ORDER_ROUTE,
      NOTIFY_CONFIRMATION_ROUTE, NOTIFY_RECEIPT_ROUTE, NOTIFY_EXCEPTION_ROUTE,
      FUND_ROUTE,
    ]) {
      app.post(path, (_req, res) => send(res, unconfigured()));
    }
    for (const path of [
      SHOP_ORDER_ROUTE, DOMAINS_STATUS_ROUTE, TRAVEL_BOOKING_ROUTE, GIFTS_STATUS_ROUTE,
      INTENT_STATUS_ROUTE, INTENT_PAYMENT_ROUTE, INTENT_DELIVERY_ROUTE, INTENT_RECEIPT_ROUTE,
      INTENT_EVENTS_ROUTE, CONSUMER_CATALOG_ROUTE,
    ]) {
      app.get(path, (_req, res) => send(res, unconfigured()));
    }
    return;
  }

  const deps: ConsumerDeps = {
    store: wiring.store,
    orchestrator: wiring.orchestrator,
    publicBaseUrl: wiring.publicBaseUrl,
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
  quote(SHOP_QUOTE_ROUTE, "shop.quote");
  post(SHOP_PURCHASE_ROUTE, (b) => handleConsumerExecute(b, deps));

  search(DOMAINS_CHECK_ROUTE, "domains.check");
  quote(DOMAINS_QUOTE_ROUTE, "domains.register");
  post(DOMAINS_REGISTER_ROUTE, (b) => handleConsumerExecute(b, deps));
  quote(DOMAINS_RENEW_ROUTE, "domains.renew");

  search(TRAVEL_SEARCH_ROUTE, "travel.search");
  search(TRAVEL_COMPARE_ROUTE, "travel.compare");
  quote(TRAVEL_QUOTE_ROUTE, "travel.quote");
  post(TRAVEL_BOOK_ROUTE, (b) => handleConsumerExecute(b, deps));

  quote(GIFTS_QUOTE_ROUTE, "gifts.order");
  post(GIFTS_ORDER_ROUTE, (b) => handleConsumerExecute(b, deps));

  notify(NOTIFY_CONFIRMATION_ROUTE, "notify.confirmation");
  notify(NOTIFY_RECEIPT_ROUTE, "notify.receipt");
  notify(NOTIFY_EXCEPTION_ROUTE, "notify.exception");

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
      const settlement = readSettlement(req);
      const funded = await wiring.orchestrator.confirmFunding(intentId, {
        intentId,
        chain: intent.fundingAmount.asset.chain,
        txHash: settlement.txHash ?? `unsettled:${intentId}`,
        amount: intent.fundingAmount,
        payer: settlement.payer,
        settledAt: new Date().toISOString(),
        confirmations: settlement.txHash === null ? 0 : 1,
        finalized: false,
      });
      await wiring.orchestrator.queueExecution(intentId).catch(() => undefined);
      return {
        status: 200,
        body: {
          intentId,
          state: funded.state,
          funded: true,
          settlementTx: settlement.txHash,
          statusUrl: `${wiring.publicBaseUrl.replace(/\/+$/, "")}/consumer/intent/${intentId}`,
          eventsUrl: `${wiring.publicBaseUrl.replace(/\/+$/, "")}/consumer/intent/${intentId}/events`,
          note: "Execution is queued. Watch the event stream; this request does not wait for it.",
        },
      };
    })()
      .then((r) => send(res, r))
      .catch(next);
  });

  // ── status surfaces (all free) ─────────────────────────────────────────────
  const statusHandler = (req: Request, res: Response, next: NextFunction): void => {
    const policyId = typeof req.query.policyId === "string" ? req.query.policyId : null;
    handleConsumerStatus(req.params.intentId ?? "", policyId, deps)
      .then((r) => send(res, r))
      .catch(next);
  };
  for (const path of [INTENT_STATUS_ROUTE, SHOP_ORDER_ROUTE, DOMAINS_STATUS_ROUTE, TRAVEL_BOOKING_ROUTE, GIFTS_STATUS_ROUTE]) {
    app.get(path, statusHandler);
  }

  app.get(INTENT_PAYMENT_ROUTE, (req, res, next) => {
    handleConsumerPayment(req.params.intentId ?? "", deps).then((r) => send(res, r)).catch(next);
  });
  app.get(INTENT_DELIVERY_ROUTE, (req, res, next) => {
    handleConsumerDelivery(req.params.intentId ?? "", deps).then((r) => send(res, r)).catch(next);
  });
  app.get(INTENT_RECEIPT_ROUTE, (req, res, next) => {
    handleConsumerReceipt(req.params.intentId ?? "", deps).then((r) => send(res, r)).catch(next);
  });

  // ── SSE ────────────────────────────────────────────────────────────────────
  app.get(INTENT_EVENTS_ROUTE, (req: Request, res: Response, next: NextFunction) => {
    const intentId = req.params.intentId ?? "";
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    attachSseStream({
      store: wiring.store,
      hub: wiring.hub,
      intentId,
      lastEventId: req.headers["last-event-id"] ?? req.query.lastEventId,
      subscriber: {
        intentId,
        write: (chunk) => res.write(chunk),
        close: () => res.end(),
      },
    })
      .then((unsubscribe) => {
        req.on("close", () => {
          unsubscribe();
          res.end();
        });
      })
      .catch(next);
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
      notify: [NOTIFY_CONFIRMATION_ROUTE, NOTIFY_RECEIPT_ROUTE, NOTIFY_EXCEPTION_ROUTE],
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
