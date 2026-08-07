import type { RouteConfig } from "@okxweb3/x402-core/server";
import {
  BRAND_PACK_PRICE,
  BRAND_PACK_ROUTE,
  DETECT_DUP_PRICE,
  DETECT_DUP_ROUTE,
  DISPUTE_PRICE,
  DISPUTE_ROUTE,
  NETWORK,
  PREFLIGHT_PRICE,
  PREFLIGHT_ROUTE,
  RECONCILE_PRICE,
  RECONCILE_ROUTE,
  REDACT_META_PRICE,
  REDACT_META_ROUTE,
  SCORE_BUYER_ROUTE,
  SCORE_PRICE,
  SCORE_VENDOR_ROUTE,
  SUGGEST_NAMES_PRICE,
  SUGGEST_NAMES_ROUTE,
  VERIFY_PRICE,
  VERIFY_ROUTE,
} from "./config";
import { challengeDescription } from "./registry/routes";

/**
 * The one table that binds a price to an HTTP resource.
 *
 * Read three times on Express — the payment middleware is configured from it, the SDK health probe is
 * computed from it, and the boot assertion refuses to start from it — and now a fourth time by the
 * Cloudflare Worker. That fourth reader is why it lives here instead of inside `createSellerApp`:
 * a price written down twice is a price that can differ between two transports serving the same
 * listing, and the caller who finds out is the one holding the bill.
 *
 * `consumerRouteTable` stays a parameter. Those entries are built from the Consumer Pack's own
 * wiring and are only meaningful where that wiring exists, so a transport without it passes nothing
 * rather than inheriting priced paths it cannot serve.
 */
export interface PaidRouteTableArgs {
  readonly payTo: string;
  readonly publicBaseUrl: string;
  readonly consumerRouteTable?: Record<string, RouteConfig>;
}

export function buildPaidRouteTable(args: PaidRouteTableArgs): Record<string, RouteConfig> {
  return {
      // Some marketplace validators probe a listed endpoint with GET/HEAD even when
      // the service is invoked with POST. Keep those probes paid and explicit rather
      // than letting Express turn them into an unhelpful 404.
      [`GET ${PREFLIGHT_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: PREFLIGHT_PRICE },
        description: challengeDescription("preflight_payment", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`HEAD ${PREFLIGHT_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: PREFLIGHT_PRICE },
        description: challengeDescription("preflight_payment", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${PREFLIGHT_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: PREFLIGHT_PRICE },
        description: challengeDescription("preflight_payment", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`GET ${VERIFY_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: VERIFY_PRICE },
        description: challengeDescription("verify_delivery", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`HEAD ${VERIFY_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: VERIFY_PRICE },
        description: challengeDescription("verify_delivery", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${VERIFY_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: VERIFY_PRICE },
        description: challengeDescription("verify_delivery", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${SCORE_VENDOR_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: SCORE_PRICE },
        description: challengeDescription("score_vendor", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${SCORE_BUYER_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: SCORE_PRICE },
        description: challengeDescription("score_buyer", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${DISPUTE_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: DISPUTE_PRICE },
        description: challengeDescription("generate_dispute_packet", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${RECONCILE_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: RECONCILE_PRICE },
        description: challengeDescription("reconcile_agent_spend", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${SUGGEST_NAMES_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: SUGGEST_NAMES_PRICE },
        description: challengeDescription("suggest_names", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${BRAND_PACK_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: BRAND_PACK_PRICE },
        description: challengeDescription("brand_pack", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`GET ${BRAND_PACK_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: BRAND_PACK_PRICE },
        description: challengeDescription("brand_pack", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`HEAD ${BRAND_PACK_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: BRAND_PACK_PRICE },
        description: challengeDescription("brand_pack", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${DETECT_DUP_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: DETECT_DUP_PRICE },
        description: challengeDescription("detect_duplicate", args.publicBaseUrl),
        mimeType: "application/json",
      },
      [`POST ${REDACT_META_ROUTE}`]: {
        accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price: REDACT_META_PRICE },
        description: challengeDescription("redact_payment_metadata", args.publicBaseUrl),
        mimeType: "application/json",
      },
      // ── Consumer Pack ──────────────────────────────────────────────────
      // Fixed prices are the ORCHESTRATION fee. The variable purchase value is a separate leg:
      // POST /consumer/fund/:intentId carries a DynamicPrice function that resolves each intent's
      // own exact authorised amount at request time.
      //
      // Every path here is also gated above, so only a caller with a proven session bound to a
      // policy they own ever reaches this table. The prices stay because that caller is a real
      // buyer of a real orchestration; what changed is that a stranger is refused for free.
    ...(args.consumerRouteTable ?? {}),
  };
}
