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

/**
 * The methods a listed endpoint answers, priced identically.
 *
 * A marketplace validator — and the `onchainos payment quote <url>` a buyer runs before paying —
 * probes a listed URL with GET before it ever POSTs. Only three of the six listed tools had GET and
 * HEAD entries here, written out by hand, so `payment quote` on the other three failed with
 * "endpoint returned HTTP 405 to the GET probe" while its neighbours quoted a price. Nothing
 * distinguished the two groups except which blocks someone had remembered to copy.
 *
 * Generating all three methods from one declaration makes the omission unrepresentable. The probe is
 * PRICED, not free: an unpaid probe gets a 402 that proves the endpoint is real and states its price,
 * and only a paid probe reaches the 405 telling it to use POST.
 */
function listedTool(
  args: PaidRouteTableArgs,
  toolId: string,
  route: string,
  price: string,
): Record<string, RouteConfig> {
  const config: RouteConfig = {
    accepts: { scheme: "exact", network: NETWORK, payTo: args.payTo, price },
    description: challengeDescription(toolId, args.publicBaseUrl),
    mimeType: "application/json",
  };
  return { [`GET ${route}`]: config, [`HEAD ${route}`]: config, [`POST ${route}`]: config };
}

export function buildPaidRouteTable(args: PaidRouteTableArgs): Record<string, RouteConfig> {
  return {
      ...listedTool(args, "preflight_payment", PREFLIGHT_ROUTE, PREFLIGHT_PRICE),
      ...listedTool(args, "verify_delivery", VERIFY_ROUTE, VERIFY_PRICE),
      ...listedTool(args, "detect_duplicate", DETECT_DUP_ROUTE, DETECT_DUP_PRICE),
      ...listedTool(args, "redact_payment_metadata", REDACT_META_ROUTE, REDACT_META_PRICE),
      ...listedTool(args, "suggest_names", SUGGEST_NAMES_ROUTE, SUGGEST_NAMES_PRICE),
      ...listedTool(args, "brand_pack", BRAND_PACK_ROUTE, BRAND_PACK_PRICE),
      /**
       * POST only, deliberately. These four are INTERNAL_OR_WITHHELD — they are not listed, so nothing
       * probes them, and giving a withheld route a GET surface would widen it for no caller's benefit.
       */
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
