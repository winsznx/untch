/**
 * The Worker entrypoint: fetch, queue and scheduled in one module.
 *
 * ROUTE ORDER IS DECLARED, NOT HOPED FOR
 *
 * The table below is ordered the way the cutover plan requires — raw-body first, then other
 * unparsed-byte routes, then form and OAuth callbacks, then JSON, then discovery and health. But the
 * router does not depend on that ordering to be correct: it prefers literal segments over parameters,
 * and `assertRawBodyRoutesFirst` fails the build if any parsing route could claim a raw path. The
 * declaration order is for a human reading the file; the guarantee is structural.
 *
 * WHAT THIS MODULE DOES NOT DO
 *
 * It does not decide anything financial. Arming and write ownership are checked here and the answers
 * are passed down; every actual decision — what a route costs, whether an authorization verifies,
 * whether a settlement confirmed, whether an approval may be acted on — still belongs to the canonical
 * modules. This is wiring.
 */

import { verifySchemaVersion, type Pool, type SchemaVerdict } from "@untch/consumer-core";
import { armingState, disarmedResponse, DisarmedError, type ArmingState } from "./arming";
import { bundledAttestation } from "./build-attestation";
import { assertBindings, environmentOf, publicBaseUrl, type WorkerEnv } from "./env";
import { buildJobs, requiredCrons, type JobDeps } from "./jobs";
import { consumeDeliveryBatch, type QueueBatch } from "./queue-delivery";
import { assertRawBodyRoutesFirst, dispatch, WorkersRouter, type Route } from "./router";
import { runScheduled } from "./scheduled";
import { cutoverPosture, writerGate, WriterGateClosedError, type WriterGate } from "./writer-gate";

export interface EntryDeps {
  readonly makePool: (connectionString: string) => Pool;
  readonly expectedMigrations: readonly string[];
  readonly jobDeps: (pool: Pool, gate: WriterGate) => JobDeps;
  readonly routes: (ctx: RouteContext) => readonly Route[];
  /**
   * What answers a path the route table does not claim.
   *
   * Injected rather than fixed at 404, because during the migration "not in this table" and "does not
   * exist" are different facts. A route Express serves that has not landed here yet must say so, and
   * only the caller knows which routes those are.
   */
  readonly onUnmatched?: (request: Request) => Response;
  /**
   * Wraps any route declaring `priced: true`.
   *
   * Built per request context rather than once, because it needs the payee and the published base URL
   * — both of which come from the environment this invocation was handed, and both of which appear in
   * the challenge a caller is asked to pay.
   */
  readonly paymentGate?: (ctx: RouteContext) =>
    | ((request: Request, body: unknown, run: () => Promise<Response>) => Promise<Response>)
    | undefined;
  readonly log?: (line: string) => void;
}

export interface RouteContext {
  readonly pool: Pool;
  readonly env: WorkerEnv;
  readonly arming: ArmingState;
  readonly gate: WriterGate;
  readonly baseUrl: string;
  readonly schema: SchemaVerdict | null;
}

/** A correlation id on every response, so one request can be followed across logs. */
const requestId = (): string => crypto.randomUUID();

/**
 * Headers every response carries.
 *
 * `nosniff` and `DENY` are cheap and unconditional. HSTS is deliberately NOT set here: Cloudflare
 * terminates TLS in front of this Worker and owns that decision at the zone, and a Worker asserting a
 * max-age the zone does not honour is a claim it cannot keep.
 */
function securityHeaders(id: string): Record<string, string> {
  return {
    "x-request-id": id,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

/**
 * CORS for the public read surface only.
 *
 * Credentials are never allowed: an approval action is authorised by a signed token or a session
 * bearer, never by an ambient cookie, so there is nothing a browser could usefully send along.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, payment-signature, x-payment",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const errorResponse = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message, retryable: false, docsUrl: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Schema verification, memoised per isolate.
 *
 * Read-only and never DDL. Cached because it is the same answer for the lifetime of an isolate against
 * a database that only a deliberate migration changes, and querying it per request would add a round
 * trip to every health check.
 */
let schemaCache: { readonly verdict: SchemaVerdict; readonly at: number } | null = null;
const SCHEMA_TTL_MS = 60_000;

export async function verifySchemaCached(
  pool: Pool,
  expected: readonly string[],
  nowMs: number = Date.now(),
): Promise<SchemaVerdict> {
  if (schemaCache && nowMs - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.verdict;
  const verdict = await verifySchemaVersion(pool as never, expected);
  schemaCache = { verdict, at: nowMs };
  return verdict;
}

export function __resetSchemaCache(): void {
  schemaCache = null;
}

/** Health, and the posture a reviewer or an operator needs to read. */
export function healthBody(ctx: RouteContext): Record<string, unknown> {
  const attestation = bundledAttestation();
  return {
    app: "untch-asp",
    environment: environmentOf(ctx.env),
    baseUrl: ctx.baseUrl,
    commit: attestation?.commit ?? null,
    commitShort: attestation ? attestation.commit.slice(0, 7) : null,
    builtAt: attestation?.builtAt ?? null,
    attested: attestation !== null,
    schema: ctx.schema === null
      ? { verified: false, reason: "not yet checked" }
      : ctx.schema.ok
        ? { verified: true, applied: ctx.schema.applied, head: ctx.schema.head }
        : { verified: false, reason: ctx.schema.reason, detail: ctx.schema.detail },
    posture: cutoverPosture(ctx.arming.armed, ctx.gate),
    armingRefusals: ctx.arming.refusals,
  };
}

export function buildWorker(deps: EntryDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));

  /** Built once per invocation: bindings can differ between preview and production. */
  async function context(env: WorkerEnv): Promise<RouteContext> {
    assertBindings(env);
    const pool = deps.makePool(env.HYPERDRIVE.connectionString);
    let schema: SchemaVerdict | null = null;
    try {
      schema = await verifySchemaCached(pool, deps.expectedMigrations);
    } catch (err) {
      log(`[entry] schema verification failed: ${(err as Error).message}`);
    }
    const arming = armingState({
      attested: bundledAttestation() !== null,
      schema,
      armedFlag: env.UNTCH_FINANCIAL_ARMED,
    });
    const gate = writerGate(env.UNTCH_PRODUCTION_WRITER_ACTIVE);
    return { pool, env, arming, gate, baseUrl: publicBaseUrl(env), schema };
  }

  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const id = requestId();
      const origin = request.headers.get("origin");

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...securityHeaders(id), ...corsHeaders(origin) } });
      }

      let ctx: RouteContext;
      try {
        ctx = await context(env);
      } catch (err) {
        log(`[entry] ${id} could not build context: ${(err as Error).message}`);
        return withHeaders(errorResponse(503, "DEPLOYMENT_NOT_READY", "this deployment cannot serve"), securityHeaders(id));
      }

      let router: WorkersRouter;
      try {
        router = new WorkersRouter().addAll(deps.routes(ctx));
        /**
         * Structural, not a comment: a parsing route that could claim a raw path would consume the
         * bytes a Discord signature covers. Treated as a DEPLOYMENT defect rather than a request
         * error, because the table is the same for every request — serving the other routes while
         * that one is silently broken is worse than refusing.
         */
        assertRawBodyRoutesFirst(router);
      } catch (err) {
        log(`[entry] ${id} unsafe route table: ${(err as Error).message}`);
        return withHeaders(
          errorResponse(503, "DEPLOYMENT_NOT_READY", "the route table is unsafe and this deployment will not serve"),
          securityHeaders(id),
        );
      }

      try {
        const paymentGate = deps.paymentGate?.(ctx);
        const res = await dispatch(router, request, {
          ...(deps.onUnmatched ? { onNotFound: deps.onUnmatched } : {}),
          ...(paymentGate ? { paymentGate } : {}),
        });
        return withHeaders(res, { ...securityHeaders(id), ...corsHeaders(origin) });
      } catch (err) {
        if (err instanceof DisarmedError) return withHeaders(disarmedResponse(err), securityHeaders(id));
        if (err instanceof WriterGateClosedError) {
          return withHeaders(
            errorResponse(503, "NOT_PRODUCTION_WRITER", "another deployment owns production writes"),
            securityHeaders(id),
          );
        }
        /**
         * The body is never echoed. An unhandled error can carry a connection string, a token or a
         * row, and a 500 that leaks one is worse than a 500 that says nothing.
         */
        log(`[entry] ${id} unhandled: ${(err as Error).message}`);
        return withHeaders(errorResponse(500, "INTERNAL_ERROR", `unexpected error (${id})`), securityHeaders(id));
      }
    },

    async queue(batch: QueueBatch, env: WorkerEnv): Promise<void> {
      const ctx = await context(env);
      /**
       * The writer gate decides whether a message may be claimed at all. Before cutover the consumer
       * still drains the queue — acking rather than leaving messages to redeliver forever — but claims
       * nothing and sends nothing.
       */
      const report = await consumeDeliveryBatch(batch, {
        pool: ctx.pool,
        claim: async (pool, deliveryId) => {
          if (!ctx.gate.ownsWrites) return { kind: "held-by-another" };
          const { claimDeliveryById } = await import("./queue-delivery");
          return claimDeliveryById(pool, deliveryId);
        },
        deliverOne: async () => {
          throw new Error("delivery transport is wired at deployment, not in the entry module");
        },
        log,
      });
      log(`[queue] ${JSON.stringify(report)}`);
    },

    async scheduled(event: { cron: string }, env: WorkerEnv): Promise<void> {
      const ctx = await context(env);
      const jobs = buildJobs(deps.jobDeps(ctx.pool, ctx.gate));
      const runs = await runScheduled(ctx.pool, jobs, event.cron, log);
      for (const r of runs) {
        log(`[scheduled] ${JSON.stringify({ job: r.job, ok: r.ok, processed: r.processed, skippedOverlap: r.skippedOverlap })}`);
      }
    },

    /** Exposed so CI can assert the wrangler config declares exactly these. */
    crons(): readonly string[] {
      return requiredCrons(buildJobs(deps.jobDeps(null as never, writerGate(undefined))));
    },
  };
}
