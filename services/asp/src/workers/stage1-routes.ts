/**
 * The Stage 1 public surface: what asp.untch.xyz serves the moment the hostname comes back.
 *
 * WHY A NAMED SUBSET RATHER THAN "WHATEVER COMPILES"
 *
 * The Express app serves 126 routes and they are being ported in risk order. While that is true, the
 * choice is not between a complete Worker and a broken one — it is between a Worker that refuses by
 * name and one that refuses by accident. So this module declares the routes it can serve truthfully,
 * and `stage1Fallback` answers everything else from the generated route manifest: a path Express
 * really serves gets a 503 that says it is migrating, and a path that never existed gets the same 404
 * Express gives. A reviewer hitting an unported endpoint learns it is coming back, and a reviewer
 * hitting a typo learns it is a typo.
 *
 * WHY THE DISCOVERY DOCUMENTS ARE NOT REWRITTEN HERE
 *
 * `/schema`, `/schema/:tool`, `/openapi.json` and `/.well-known/x402` are built by the SAME functions
 * Express calls. Restating them for Workers would have created a second copy of the contract with
 * nothing comparing the two, which is the exact failure the registry was built to end. The only thing
 * this module adds is a `deployment` block naming which paths are callable right now — additive, so
 * every canonical field is byte-identical to what Express produces for the same base URL.
 *
 * WHAT CANNOT HAPPEN HERE
 *
 * No route in this table writes to the database, enqueues a message, mints or verifies an
 * authorization, or settles anything. The unported paid routes refuse BEFORE any payment gate, which
 * matters more than it looks: a 402 is an invitation to pay, and issuing one for a handler that does
 * not exist would invite a caller to buy work this deployment cannot perform.
 */

import { loadConsumerFlags } from "@untch/consumer-core";
import {
  CAFE_LATTE_ROUTE,
  CAFE_MENU_ROUTE,
  CATALOG_ROUTE,
  CHECK_DOMAINS_ROUTE,
  PING_ROUTE,
  RANK_OPTIONS_ROUTE,
  RECEIPT_STATUS_ROUTE,
  SEO_TIPS_ROUTE,
  LOG_RECEIPT_ROUTE,
  GET_LEDGER_ROUTE,
} from "../config";
import { coerceObjectParams } from "./coerce-params";
import { logReceiptRoute, receiptReader, receiptStatusRoute } from "./receipt-reads";
import { getLedgerRoute } from "./ledger-route";
import {
  handleCafeMenu,
  handleCafeOrderLatte,
  handleCatalog,
  handleCheckDomains,
  handleRankOptions,
  handleSeoTips,
} from "../consumer-handlers";
import type { HandlerResult } from "../handlers";
import { EXECUTION_MANIFEST_ROUTE, executionManifest } from "../route-profiles";
import { AGENT_REGISTRATION_PATH, DEFAULT_WELL_KNOWN_PATH } from "../erc8004/constants";
import { buildRegistrationCard } from "../erc8004/registration-card";
import { ERC8004_AGENT_ID } from "../registry/marketplace-identity";
import { buildOpenApi, buildWellKnownX402 } from "../registry/openapi";
import {
  buildSchemaIndex,
  publicSchemaFor,
  OPENAPI_ROUTE,
  SCHEMA_INDEX_ROUTE,
  SCHEMA_ROUTE,
  WELL_KNOWN_X402_ROUTE,
} from "../registry/routes";
import { serviceById } from "../registry/services";
import type { RouteContext } from "./entry";
import { healthBody } from "./entry";
import manifest from "./route-manifest.generated.json";
import type { Route } from "./router";

/** The settlement facts the x402 document publishes. Public by nature: an address and a token. */
export interface Stage1Settlement {
  readonly network: string;
  readonly payTo: string;
  readonly asset: { readonly symbol: string; readonly address: string; readonly decimals: number };
}

const CACHE_DISCOVERY = "public, max-age=60";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers },
  });
}

const discovery = (body: unknown): Response => json(body, 200, { "cache-control": CACHE_DISCOVERY });

/**
 * A `HandlerResult` as a `Response`, carrying the headers the handler asked for.
 *
 * The handlers return `{ status, body, headers? }` because the body is the contract and the transport
 * is not their concern. `headers` is rare and load-bearing where it appears — a refusal that wants a
 * backoff hint and must never be cached — so dropping it here would quietly change behaviour Express
 * has.
 */
function fromResult(result: HandlerResult): Response {
  return json(result.body, result.status, { ...(result.headers ?? {}) });
}

/**
 * The paths this deployment actually answers.
 *
 * Adding an entry is the deliberate act of claiming the handler exists and works. Everything absent
 * from this set is answered by `stage1Fallback`, so there is no third state where a route half-works.
 */
export const STAGE1_SERVED: ReadonlySet<string> = new Set<string>([
  "/healthz",
  "/readyz",
  "/internal/deployment",
  PING_ROUTE,
  CATALOG_ROUTE,
  SCHEMA_INDEX_ROUTE,
  SCHEMA_ROUTE,
  OPENAPI_ROUTE,
  WELL_KNOWN_X402_ROUTE,
  AGENT_REGISTRATION_PATH,
  DEFAULT_WELL_KNOWN_PATH,
  CAFE_LATTE_ROUTE,
  CAFE_MENU_ROUTE,
  EXECUTION_MANIFEST_ROUTE,
  // The three free marketplace tools. Free is what makes them portable ahead of the payment gate.
  RANK_OPTIONS_ROUTE,
  SEO_TIPS_ROUTE,
  CHECK_DOMAINS_ROUTE,
  // A read. It answers from Postgres and holds nothing that could enqueue a receipt.
  RECEIPT_STATUS_ROUTE, LOG_RECEIPT_ROUTE, GET_LEDGER_ROUTE,
]);

/**
 * The GET compatibility probe, and why only one of the four is here.
 *
 * Express registers a GET handler on each POST-only business route so a marketplace validator that
 * GET-probes a listed endpoint learns the endpoint is real and takes POST, rather than getting a 404
 * that reads as a delisting.
 *
 * But those four routes sit BEHIND the payment middleware, so on Express a GET to the three priced
 * ones answers 402 with a live challenge, and only a paid probe reaches the 405. This deployment has
 * no payment gate wired, and imitating the 402 would issue an invitation to pay for a handler that
 * cannot deliver — the one thing Stage 1 must never do. So the three priced probes are left to the
 * 503 fallback, which says the endpoint is real and temporarily unavailable and asks for no money.
 *
 * `/cafe/order/latte` is free, so its probe is the same 405 on both transports and it is served here.
 */
const GET_PROBE_ROUTES = [CAFE_LATTE_ROUTE] as const;

/**
 * The honest annotation attached to every discovery document.
 *
 * A caller reading `/.well-known/x402` sees the canonical resource list — that list is the contract
 * and does not change with deployment progress — and next to it, what this deployment can serve
 * today. Publishing one without the other is how a client ends up paying for a 503.
 */
function deploymentNote(ctx: RouteContext): Record<string, unknown> {
  return {
    stage: "STAGE_1_PUBLIC_SAFE_SURFACE",
    callablePaths: [...STAGE1_SERVED].sort(),
    migrating:
      "Every other path in this document is being moved to Cloudflare Workers. Until it lands it " +
      "answers 503 before any payment is requested, so no authorization can be spent against it.",
    financiallyArmed: ctx.arming.armed,
    productionWriter: ctx.gate.ownsWrites ? "this deployment" : "elsewhere",
  };
}

export function stage1Routes(ctx: RouteContext, settlement: Stage1Settlement): readonly Route[] {
  const baseUrl = ctx.baseUrl;
  const registry = { baseUrl, network: settlement.network };

  /**
   * The ERC-8004 card, built by the canonical builder.
   *
   * Served at both paths Express serves it at. The marketplace reads one and the well-known
   * convention says the other, and a card that resolves at only one of them looks like a delisting.
   */
  const registrationCard = (): Response =>
    discovery(buildRegistrationCard({ baseUrl, payTo: settlement.payTo, agentId: ERC8004_AGENT_ID }));

  return [
    ...GET_PROBE_ROUTES.map(
      (pattern): Route => ({
        method: "GET",
        pattern,
        bodyMode: "none",
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
      }),
    ),

    {
      method: "GET",
      pattern: PING_ROUTE,
      bodyMode: "none",
      handler: () => json({ ok: true, tool: "ping_untch", ts: new Date().toISOString() }),
    },

    /**
     * The free surface, served by the same handlers Express calls.
     *
     * Free is exactly what makes these portable ahead of the payment gate: there is no authorization
     * to verify, nothing to settle, and no service-call row to write — so the closed writer gate does
     * not change any answer. The six paid tools stay on the 503 until their gate is wired, because a
     * paid handler this deployment cannot settle for must not be reachable at all.
     */
    { method: "GET", pattern: CAFE_MENU_ROUTE, bodyMode: "none", handler: () => fromResult(handleCafeMenu()) },
    {
      /**
       * PRODUCTION_DISABLED, and now actually disabled.
       *
       * The registry classifies this `PRODUCTION_DISABLED` and the catalog said so, but the route was
       * ported alongside the free tools and kept fulfilling: an empty unpaid POST returned an order id
       * and `"amountPaid":"4.00"`, describing a payment that never happened for coffee that does not
       * exist. A label is not a gate — the same failure the arming fix corrected, on the disable side.
       *
       * Refused with its own code rather than the migration 503, because "deliberately off" and "not
       * ported yet" are different facts and a caller deciding whether to retry needs to tell them apart.
       */
      method: "POST",
      pattern: CAFE_LATTE_ROUTE,
      bodyMode: "none",
      handler: () =>
        json(
          {
            code: "SERVICE_PRODUCTION_DISABLED",
            message:
              "the cafe order simulation is disabled in production. It contacted no merchant, placed no " +
              "order and produced no coffee, and returning a paid-looking receipt for it misrepresented " +
              "what a payment buys.",
            retryable: false,
            docsUrl: "https://docs.untch.xyz",
          },
          410,
        ),
    },
    {
      method: "POST",
      pattern: RANK_OPTIONS_ROUTE,
      bodyMode: "json",
      handler: (req) => fromResult(handleRankOptions(coerceObjectParams(req.body))),
    },
    {
      method: "POST",
      pattern: SEO_TIPS_ROUTE,
      bodyMode: "json",
      handler: (req) => fromResult(handleSeoTips(coerceObjectParams(req.body))),
    },
    {
      /**
       * Live RDAP, so this one reaches the public internet from the Worker. It uses global `fetch`
       * and no Node-only transport, and it is the same call Express makes — a registry lookup against
       * public RDAP endpoints, with no credential and nothing written down.
       */
      method: "POST",
      pattern: CHECK_DOMAINS_ROUTE,
      bodyMode: "json",
      handler: async (req) => fromResult(await handleCheckDomains(coerceObjectParams(req.body))),
    },

    {
      method: "GET",
      pattern: EXECUTION_MANIFEST_ROUTE,
      bodyMode: "none",
      handler: () => json(executionManifest(loadConsumerFlags().executionEnabled)),
    },

    /**
     * The §7.4 receipt poll. Unpriced, unauthenticated, and read-only — a caller holding a receipt id
     * got it from this service and is entitled to know what happened to it.
     */
    receiptStatusRoute(receiptReader(ctx.pool)),
    /**
     * `log_receipt` reads the same Postgres row as `receipt_status`. It sat on the 503 because the
     * Express wiring it asked for builds a Redis connection alongside the repo, and a Worker has no
     * Redis — but Redis is how a receipt gets ENQUEUED, not how its status is read.
     */
    logReceiptRoute(receiptReader(ctx.pool)),
    /** Refused by name, with the reason and the two routes that do answer. See `ledger-route.ts`. */
    getLedgerRoute(),

    { method: "GET", pattern: "/healthz", bodyMode: "none", handler: () => json(healthBody(ctx)) },

    {
      method: "GET",
      pattern: "/readyz",
      bodyMode: "none",
      handler: () => {
        const ready = ctx.schema !== null && ctx.schema.ok;
        return json({ ...healthBody(ctx), ready }, ready ? 200 : 503);
      },
    },

    {
      method: "GET",
      pattern: "/internal/deployment",
      bodyMode: "none",
      handler: () => json({ ...healthBody(ctx), deployment: deploymentNote(ctx) }),
    },

    {
      method: "GET",
      pattern: CATALOG_ROUTE,
      bodyMode: "none",
      handler: () => {
        const result = handleCatalog();
        return json({ ...(result.body as Record<string, unknown>), deployment: deploymentNote(ctx) }, result.status);
      },
    },

    {
      method: "GET",
      pattern: SCHEMA_INDEX_ROUTE,
      bodyMode: "none",
      handler: () => discovery({ ...buildSchemaIndex(registry), deployment: deploymentNote(ctx) }),
    },

    {
      method: "GET",
      pattern: SCHEMA_ROUTE,
      bodyMode: "none",
      handler: (req) => {
        const service = serviceById(String(req.params.tool ?? ""));
        if (!service) {
          return json(
            {
              code: "TOOL_NOT_FOUND",
              message: `no tool named ${JSON.stringify(req.params.tool)} — GET ${baseUrl}/schema lists every one`,
              retryable: false,
              docsUrl: `${baseUrl}/schema`,
            },
            404,
          );
        }
        return discovery(publicSchemaFor(service, baseUrl));
      },
    },

    {
      method: "GET",
      pattern: OPENAPI_ROUTE,
      bodyMode: "none",
      handler: () => discovery(buildOpenApi(registry)),
    },

    {
      method: "GET",
      pattern: WELL_KNOWN_X402_ROUTE,
      bodyMode: "none",
      handler: () =>
        discovery({
          ...buildWellKnownX402({ ...registry, payTo: settlement.payTo, asset: settlement.asset }),
          deployment: deploymentNote(ctx),
        }),
    },

    { method: "GET", pattern: AGENT_REGISTRATION_PATH, bodyMode: "none", handler: registrationCard },
    { method: "GET", pattern: DEFAULT_WELL_KNOWN_PATH, bodyMode: "none", handler: registrationCard },
  ];
}

interface ManifestRoute {
  readonly method: string;
  readonly path: string;
}

/** Every route the real Express app serves, compiled once so the fallback can tell 503 from 404. */
const EXPRESS_ROUTES: readonly { method: string; pattern: string; regex: RegExp }[] = (
  manifest.routes as readonly ManifestRoute[]
).map((r) => ({
  method: r.method,
  pattern: r.path,
  regex: new RegExp(
    `^${r.path
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "([^/]+)" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}/?$`,
  ),
}));

/**
 * The answer for every path this deployment does not serve yet.
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *   503  Express serves this path. It is being migrated, it will come back, retry later.
 *   405  Express serves this path under a different method, and `Allow` says which.
 *   404  No such route, in the same envelope Express returns, so a typo reads the same on both.
 *
 * Collapsing these into one 404 would tell a marketplace validator that two thirds of the service had
 * been withdrawn. Collapsing them into one 503 would tell a client that a misspelled path is coming
 * back. Neither is true, so neither is served.
 */
export function stage1Fallback(request: Request): Response {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  const samePath = EXPRESS_ROUTES.filter((r) => r.regex.test(path));

  if (samePath.some((r) => r.method === method)) {
    return json(
      {
        code: "SERVICE_TEMPORARILY_UNAVAILABLE",
        message:
          `${method} ${path} is being migrated to Cloudflare Workers and is not callable yet. It refuses ` +
          "before any payment is requested, so no authorization is spent by this response.",
        retryable: true,
        docsUrl: "https://docs.untch.xyz",
      },
      503,
      { "retry-after": "300" },
    );
  }

  if (samePath.length > 0) {
    const allow = [...new Set(samePath.map((r) => r.method))].sort();
    return json(
      {
        code: "METHOD_NOT_ALLOWED",
        message: `${path} exists but does not accept ${method}; it accepts ${allow.join(", ")}`,
        retryable: false,
        docsUrl: "https://docs.untch.xyz",
      },
      405,
      { allow: allow.join(", ") },
    );
  }

  return json(
    {
      code: "ROUTE_NOT_FOUND",
      message: `no route for ${method} ${path} — GET /catalog lists every tool this service serves`,
      retryable: false,
      docsUrl: "https://docs.untch.xyz",
    },
    404,
  );
}
