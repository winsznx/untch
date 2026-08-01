import type { Express, Request, Response } from "express";
import { SERVICES, serviceById } from "./services";
import { buildOpenApi, buildWellKnownX402 } from "./openapi";
import { threePartDescription } from "./listing";
import { describeViolations, validate } from "./schema";
import type { ServiceDefinition } from "./types";

/**
 * The three routes that stop the contract from being a secret.
 *
 *   GET /schema            — the index: every tool, its price, and where its contract is
 *   GET /schema/:tool      — one contract, in full
 *   GET /openapi.json      — the whole surface, machine-readable
 *   GET /.well-known/x402  — what costs money, on what chain, and where each contract lives
 *
 * All four are free and unauthenticated, deliberately. The failure being corrected is that the only
 * way to learn a tool's parameters was to pay for a refusal; a discovery route behind a paywall would
 * reproduce it with extra steps.
 *
 * They are registered BEFORE the payment middleware for the same reason the health route is: a
 * discovery document that 402s is not discovery.
 */

export const SCHEMA_INDEX_ROUTE = "/schema" as const;
export const SCHEMA_ROUTE = "/schema/:tool" as const;
export const OPENAPI_ROUTE = "/openapi.json" as const;
export const WELL_KNOWN_X402_ROUTE = "/.well-known/x402" as const;

export interface RegistryRouteConfig {
  readonly baseUrl: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset: { readonly symbol: string; readonly address: string; readonly decimals: number };
}

/** The published form of one service. Everything the registry knows, minus nothing. */
export function publicSchemaFor(service: ServiceDefinition, baseUrl: string): Record<string, unknown> {
  const description = threePartDescription(service);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    toolId: service.toolId,
    name: service.publicName,
    protocol: service.protocol,
    endpoint: `${baseUrl}${service.path}`,
    method: service.method,
    pricing: service.pricing,
    maturity: service.maturity,
    schemaVersion: service.schemaVersion,
    description: { what: description.what, provide: description.provide, receive: description.receive },
    input: service.input,
    output: service.output,
    examples: {
      valid: { title: service.validExample.title, request: service.validExample.request },
      refused: {
        title: service.invalidExample.title,
        request: service.invalidExample.request,
        refusalCode: service.invalidExample.refusalCode ?? null,
      },
    },
    /**
     * The part a schema alone cannot say. Both rejected services had answerable input schemas and
     * were still uncallable, because something they required had no public route that produced it.
     */
    predecessors: service.predecessors,
    sideEffects: service.sideEffects,
    idempotency: service.idempotency,
    refusals: service.refusals,
  };
}

export function registerRegistryRoutes(app: Express, config: RegistryRouteConfig): void {
  const cache = (res: Response): void => {
    res.setHeader("cache-control", "public, max-age=60");
    res.setHeader("access-control-allow-origin", "*");
  };

  app.get(SCHEMA_INDEX_ROUTE, (_req: Request, res: Response) => {
    cache(res);
    res.json({
      baseUrl: config.baseUrl,
      network: config.network,
      count: SERVICES.length,
      note: "Every contract this host enforces. Nothing here requires payment to read.",
      tools: SERVICES.map((s) => ({
        toolId: s.toolId,
        name: s.publicName,
        method: s.method,
        endpoint: `${config.baseUrl}${s.path}`,
        pricing: s.pricing,
        maturity: s.maturity,
        schema: `${config.baseUrl}/schema/${s.toolId}`,
        schemaVersion: s.schemaVersion,
      })),
    });
  });

  app.get(SCHEMA_ROUTE, (req: Request, res: Response) => {
    const service = serviceById(String(req.params.tool ?? ""));
    if (!service) {
      res.status(404).json({
        code: "TOOL_NOT_FOUND",
        message: `no tool named ${JSON.stringify(req.params.tool)} — GET ${config.baseUrl}/schema lists every one`,
        retryable: false,
        docsUrl: `${config.baseUrl}/schema`,
      });
      return;
    }
    cache(res);
    res.json(publicSchemaFor(service, config.baseUrl));
  });

  app.get(OPENAPI_ROUTE, (_req: Request, res: Response) => {
    cache(res);
    res.json(buildOpenApi({ baseUrl: config.baseUrl, network: config.network }));
  });

  app.get(WELL_KNOWN_X402_ROUTE, (_req: Request, res: Response) => {
    cache(res);
    res.json(
      buildWellKnownX402({
        baseUrl: config.baseUrl,
        network: config.network,
        payTo: config.payTo,
        asset: config.asset,
      }),
    );
  });
}

/**
 * The one line the 402 challenge carries.
 *
 * The registered challenge descriptions cited "§7.1", "§13/§7.3", "§12" and "§10.3" — references into
 * an internal document no marketplace reader can open. This says what the tool does and where its
 * contract is, which is what someone holding a bill actually needs. `threePartDescription` already
 * refuses private section numbers, and this reuses its summary rather than restating it.
 */
export function challengeDescription(toolId: string, baseUrl: string): string {
  const service = serviceById(toolId);
  if (!service) return `Untch ${toolId}`;
  return `${service.publicName} — ${service.summary} Full contract, free to read: ${baseUrl}/schema/${toolId}`;
}

/**
 * Validate a request body against its registered contract, before the handler sees it.
 *
 * Returns null when the body conforms. The refusal it produces names every problem at once rather
 * than the first — an agent that has to make one round trip per wrong field will make seventeen of
 * them against `preflight_payment`, and each one after the first is a request nobody needed.
 *
 * It does NOT replace the handlers' own validation. The handlers derive canonical values, resolve
 * hashes and check bindings against stored state, which is work a schema cannot do. What this adds is
 * that the published contract and the enforced one are now the same document: a body the schema
 * accepts cannot be rejected for a SHAPE reason further in.
 */
export function validateAgainstRegistry(
  toolId: string,
  body: unknown,
): { readonly code: string; readonly message: string } | null {
  const service = serviceById(toolId);
  if (!service) return null;
  const violations = validate(service.input, body ?? {});
  const message = describeViolations(violations);
  if (!message) return null;
  return {
    code: "REQUEST_SCHEMA_VIOLATION",
    message: `${message}. The full contract is at /schema/${toolId}.`,
  };
}
