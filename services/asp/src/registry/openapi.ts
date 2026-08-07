import { ERROR_ENVELOPE, SERVICES } from "./services";
import { threePartDescription } from "./listing";
import type { ServiceDefinition } from "./types";

/**
 * OpenAPI 3.1, generated from the registry.
 *
 * There was no `/openapi.json`. There was no `/.well-known/x402`, no MCP `tools/list`, and the 402
 * body was `{}` — so a marketplace agent that wanted to know what a tool took had exactly one way to
 * find out, which was to pay for a refusal. This document is the machine-readable half of the fix;
 * `/schema/:tool` is the human-and-agent-readable half.
 *
 * Everything a reader needs to decide whether they CAN call a service, rather than only what to send,
 * is carried in vendor extensions: what must already exist, what will change, whether a retry is safe,
 * and what it costs. Those are the questions the rejection was really about — the two services were
 * not under-described, they were unreachable, and a spec that omits reachability describes a door
 * without mentioning it is locked.
 */

interface OpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  /**
   * OpenAPI's own word for "still here, do not build on it".
   *
   * `approval_decide` is the reason this field exists: it is a legacy human control route that the
   * bound-action path replaced, it refuses any modern paid approval request that has no bound
   * action, and it was nonetheless advertised as a free marketplace service. Removing it from the
   * listing stops it being sold; marking it deprecated stops a reader of the spec from adopting it.
   */
  readonly deprecated?: boolean;
  readonly requestBody?: unknown;
  readonly parameters?: readonly unknown[];
  readonly responses: Record<string, unknown>;
  readonly "x-untch-pricing": unknown;
  readonly "x-untch-maturity": string;
  /** The service class, published so a spec reader can see what is on offer and what is not. */
  readonly "x-untch-class": string;
  readonly "x-untch-predecessors": unknown;
  readonly "x-untch-side-effects": unknown;
  readonly "x-untch-idempotency": string;
  readonly "x-untch-schema-version": string;
}

function pathParameters(service: ServiceDefinition): readonly unknown[] {
  const names = [...service.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: `The ${name} this request is about.`,
  }));
}

function responsesFor(service: ServiceDefinition): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description: service.delivers,
      content: { "application/json": { schema: service.output } },
    },
  };
  // One entry per distinct status, listing every code that can produce it. A caller branches on the
  // code, not the status, so the codes are what the document has to carry.
  const byStatus = new Map<number, string[]>();
  for (const r of service.refusals) {
    byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), `${r.code} — ${r.when}`]);
  }
  for (const [status, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    responses[String(status)] = {
      description: codes.join("; "),
      content: { "application/json": { schema: ERROR_ENVELOPE } },
    };
  }
  return responses;
}

function operationFor(service: ServiceDefinition): OpenApiOperation {
  const description = threePartDescription(service);
  const op: OpenApiOperation = {
    operationId: service.toolId,
    summary: service.summary,
    description: description.text,
    tags: [service.protocol],
    ...(service.deprecated ? { deprecated: true } : {}),
    /**
     * Any method that carries a body, not POST specifically.
     *
     * `set_default_policy` is a PUT, and this read `=== "POST"` — so the moment the registry started
     * telling the truth about its method, the published OpenAPI silently dropped its request body and
     * described a PUT that takes no input. A caller generating a client from it would have sent an
     * empty body to a route whose first check is `policyId is required`.
     */
    ...(service.method !== "GET"
      ? {
          requestBody: {
            required: (service.input.required ?? []).length > 0,
            content: {
              "application/json": {
                schema: service.input,
                examples: {
                  valid: { summary: service.validExample.title, value: service.validExample.request },
                  refused: {
                    summary: `${service.invalidExample.title} → ${service.invalidExample.refusalCode ?? "refused"}`,
                    value: service.invalidExample.request,
                  },
                },
              },
            },
          },
        }
      : {}),
    ...(pathParameters(service).length > 0 ? { parameters: pathParameters(service) } : {}),
    responses: responsesFor(service),
    "x-untch-pricing": service.pricing,
    "x-untch-maturity": service.maturity,
    "x-untch-class": service.classification.serviceClass,
    "x-untch-predecessors": service.predecessors,
    "x-untch-side-effects": service.sideEffects,
    "x-untch-idempotency": service.idempotency,
    "x-untch-schema-version": service.schemaVersion,
  };
  return op;
}

export function buildOpenApi(args: { readonly baseUrl: string; readonly network: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const service of SERVICES) {
    const path = paths[service.path] ?? {};
    path[service.method.toLowerCase()] = operationFor(service);
    paths[service.path] = path;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Untch — spend control for agents",
      version: "1.0.0",
      description:
        "Every service this host offers, generated from the definitions its own validators enforce. " +
        "Each operation carries what must already exist before it can succeed, what it will change, " +
        "whether repeating it is safe, and what it costs.",
    },
    servers: [{ url: args.baseUrl }],
    "x-untch-network": args.network,
    "x-untch-payment": {
      protocol: "x402",
      note: "Paid operations answer 402 with a payment challenge before the handler runs. The challenge names this schema.",
    },
    paths,
    components: { schemas: { Refusal: ERROR_ENVELOPE } },
  };
}

/**
 * The x402 discovery document.
 *
 * `/.well-known/x402` was a 404 serving an HTML page. This is the smallest thing that answers the
 * question a paying client asks first — which routes cost money, how much, on what chain, in what
 * asset, to whom — and, crucially, where the parameter contract for each one lives, so the answer to
 * "what do I send" never again requires a payment.
 */
export function buildWellKnownX402(args: {
  readonly baseUrl: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset: { readonly symbol: string; readonly address: string; readonly decimals: number };
}): Record<string, unknown> {
  return {
    x402Version: 2,
    network: args.network,
    payTo: args.payTo,
    asset: args.asset,
    schemaIndex: `${args.baseUrl}/schema`,
    openapi: `${args.baseUrl}/openapi.json`,
    /**
     * Only what a stranger can actually buy.
     *
     * This filtered on price alone, which advertised ten paid resources when six are purchasable. The
     * other four are the Bureau tools: they carry a price in the registry and refuse before any payment
     * challenge, because they answer from receipt history this host holds and a stranger has none.
     * Listing them in the document a paying client reads FIRST invites payment for a refusal.
     *
     * `MARKETPLACE_LISTABLE` is the same class the catalog and the relisting payload use, so what x402
     * discovery offers and what the marketplace sells can no longer disagree.
     */
    resources: SERVICES.filter(
      (s) => s.pricing.kind === "paid" && s.classification.serviceClass === "MARKETPLACE_LISTABLE",
    ).map((s) => ({
      toolId: s.toolId,
      name: s.publicName,
      resource: `${args.baseUrl}${s.path}`,
      method: s.method,
      scheme: "exact",
      price: s.pricing.price,
      amountBaseUnits: s.pricing.amountBaseUnits,
      description: s.summary,
      schema: `${args.baseUrl}/schema/${s.toolId}`,
      schemaVersion: s.schemaVersion,
      idempotency: s.idempotency,
      maturity: s.maturity,
    })),
    /**
     * Free things a stranger can call, on the same rule as the paid list.
     *
     * `PUBLIC_SUPPORT` is included alongside the listable ones because discovery, the schema index and
     * the liveness probe are genuinely callable by anyone and are what a client reads next. Account
     * control and the disabled café simulation are not: one needs an account this caller does not have,
     * and the other sells nothing.
     */
    freeResources: SERVICES.filter(
      (s) =>
        s.pricing.kind === "free" &&
        (s.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
          s.classification.serviceClass === "PUBLIC_SUPPORT"),
    ).map((s) => ({
      toolId: s.toolId,
      resource: `${args.baseUrl}${s.path}`,
      method: s.method,
      schema: `${args.baseUrl}/schema/${s.toolId}`,
    })),
  };
}
