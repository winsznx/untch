/**
 * Proof that the official OKX Payment SDK is around each paid route, per route.
 *
 * WHY A PER-ROUTE ANSWER
 *
 * OKX names missing Payment SDK integration as a common cause of rejection and delisting, and a
 * dependency in `package.json` proves nothing about what happens at runtime. Neither does a
 * process-level boolean: `paymentMiddleware` is configured from a table, and a route absent from
 * that table is unprotected no matter how many of its neighbours are protected. A green light that a
 * route inherits from the process it shares is the exact shape of a false assurance, so every answer
 * here is keyed on `METHOD /path` and derived from the table the middleware was actually built with.
 *
 * WHAT IT COMPARES
 *
 * The registry says what a service costs. The route table says what the middleware will charge. This
 * reads both and reports whether they are the same number — on the same chain, in the same token, to
 * the same payee. A price stated in one place and charged in another is how a listing comes to
 * advertise `$0.05` for a route that bills `$0.50`, and nothing in either file would have noticed.
 *
 * WHAT IT NEVER EXPOSES
 *
 * No API key, no secret, no passphrase, no facilitator credential. The payee address and the token
 * contract are already published in every 402 challenge this service emits, so repeating them in a
 * health document discloses nothing that a single unpaid request would not.
 */

import type { RouteConfig } from "@okxweb3/x402-core/server";
import { SERVICES } from "./registry/services";
import type { ServiceDefinition } from "./registry/types";

/** Free and unauthenticated: a reviewer must not have to pay to check that payments are integrated. */
export const PAYMENT_SDK_HEALTH_ROUTE = "/payment-sdk-health" as const;

/** The x402 network this deployment settles on. Anything else is a misconfiguration, not a variant. */
export const REQUIRED_NETWORK = "eip155:196" as const;

/** USDT0 on X Layer. Compared lowercased, because a checksum address is the same address. */
export const REQUIRED_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736" as const;

export type ProtectionStatus =
  /** In the SDK's route table, at the registry's price, on the right chain, in the right token. */
  | "protected"
  /** Priced by the registry and absent from the SDK's route table. A route that cannot charge. */
  | "unprotected"
  /** In the table and disagreeing with the registry about price, chain, token or payee. */
  | "mismatched";

export interface RouteProtection {
  readonly toolId: string;
  readonly methodPath: string;
  readonly status: ProtectionStatus;
  /** Present only when the status is not `protected`. One sentence naming the exact disagreement. */
  readonly detail?: string;
}

export interface PaymentSdkHealth {
  /**
   * True only when every paid marketplace service is `protected`. Reported beside the per-route
   * answers rather than instead of them, so a reader can see which route spoiled it.
   */
  readonly ok: boolean;
  readonly sdk: { readonly middleware: string; readonly scheme: string; readonly network: string };
  readonly settlementToken: string;
  readonly payTo: string;
  readonly routes: readonly RouteProtection[];
}

/** Reads `"$0.05"` as `"50000"` base units, the same conversion the registry records by hand. */
function baseUnits(price: string): string | null {
  const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(price.trim());
  if (!match) return null;
  return String(Math.round(Number(match[1]) * 1_000_000));
}

function checkOne(service: ServiceDefinition, table: Record<string, RouteConfig>): RouteProtection {
  const methodPath = `${service.method} ${service.path}`;
  const config = table[methodPath];
  if (!config) {
    return {
      toolId: service.toolId,
      methodPath,
      status: "unprotected",
      detail:
        "the registry prices this service and the SDK's route table has no entry for it, so an " +
        "unpaid request reaches the handler",
    };
  }

  const accepts = config.accepts;
  if (!accepts || Array.isArray(accepts)) {
    return {
      toolId: service.toolId,
      methodPath,
      status: "mismatched",
      detail: "the route entry does not carry a single `accepts` requirement this check can read",
    };
  }

  if (accepts.network !== REQUIRED_NETWORK) {
    return {
      toolId: service.toolId,
      methodPath,
      status: "mismatched",
      detail: `settles on ${String(accepts.network)}, and this deployment settles on ${REQUIRED_NETWORK}`,
    };
  }

  /**
   * The price may be a string or a function.
   *
   * `/consumer/fund/:intentId` carries a `DynamicPrice` that resolves each intent's own authorised
   * amount at request time, so there is no fixed number to compare. That route is not a marketplace
   * service and never reaches this check, but the shape is handled rather than crashed on, because a
   * check that throws on a legitimate configuration is a check somebody will delete.
   */
  const price = accepts.price;
  if (typeof price !== "string") {
    return {
      toolId: service.toolId,
      methodPath,
      status: "mismatched",
      detail: "priced by a function, which a marketplace service with a published fixed price must not be",
    };
  }

  const charged = baseUnits(price);
  if (charged === null) {
    return {
      toolId: service.toolId,
      methodPath,
      status: "mismatched",
      detail: `the route table's price ${JSON.stringify(price)} is not an amount this check can read`,
    };
  }
  if (charged !== service.pricing.amountBaseUnits) {
    return {
      toolId: service.toolId,
      methodPath,
      status: "mismatched",
      detail:
        `charges ${charged} base units and the published contract says ` +
        `${String(service.pricing.amountBaseUnits)} (${String(service.pricing.price)})`,
    };
  }

  return { toolId: service.toolId, methodPath, status: "protected" };
}

/**
 * The health document.
 *
 * `table` must be the SAME object handed to `paymentMiddleware`. Passing a copy assembled for this
 * check would make it a test of the copy, which is the failure mode the whole module is arguing
 * against — so server.ts builds one table and reads it twice.
 */
export function paymentSdkHealth(args: {
  readonly table: Record<string, RouteConfig>;
  readonly payTo: string;
}): PaymentSdkHealth {
  const paidMarketplace = SERVICES.filter(
    (s) => s.classification.serviceClass === "MARKETPLACE_LISTABLE" && s.pricing.kind === "paid",
  );
  const routes = paidMarketplace.map((s) => {
    const checked = checkOne(s, args.table);
    if (checked.status !== "protected") return checked;
    const accepts = args.table[checked.methodPath]?.accepts;
    const single = accepts && !Array.isArray(accepts) ? accepts : null;
    if (single && String(single.payTo).toLowerCase() !== args.payTo.toLowerCase()) {
      return {
        ...checked,
        status: "mismatched" as const,
        detail: "pays a different address than this deployment's configured seller wallet",
      };
    }
    return checked;
  });

  return {
    ok: routes.every((r) => r.status === "protected"),
    sdk: { middleware: "@okxweb3/x402-express", scheme: "exact", network: REQUIRED_NETWORK },
    settlementToken: REQUIRED_ASSET,
    payTo: args.payTo,
    routes,
  };
}

/**
 * Refuse to start rather than serve an unprotected paid route.
 *
 * A health document nobody reads is not a control. If a marketplace service is priced in the
 * registry and missing from the middleware's table, the running process would hand its result away
 * for free to anyone who asked, and it would do so quietly. There is no useful degraded mode between
 * "charges correctly" and "gives the product away", so this throws.
 */
export function assertPaidRoutesProtected(health: PaymentSdkHealth): void {
  const broken = health.routes.filter((r) => r.status !== "protected");
  if (broken.length === 0) return;
  const lines = broken.map((r) => `  ${r.methodPath} — ${r.status}: ${r.detail ?? "no detail"}`);
  throw new Error(
    `the official OKX Payment SDK does not protect ${broken.length} paid marketplace route(s):\n${lines.join("\n")}`,
  );
}
