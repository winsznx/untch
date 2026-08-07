/**
 * The module wrangler points at.
 *
 * Deliberately thin. Everything decidable lives in `entry.ts`, `stage1-routes.ts` and the canonical
 * business modules, so this file is the one place where a Cloudflare-shaped export meets them.
 *
 * The route table is the Stage 1 subset: health, readiness, deployment posture, and the discovery
 * documents a marketplace reviewer reads. The other Express routes are ported in their own changes and
 * answer 503 until they land — see `stage1Fallback` for why that is three different answers and not
 * one.
 */

import pg from "pg";
import { NETWORK, SETTLEMENT_TOKEN } from "../config";
import { buildWorker, type RouteContext } from "./entry";
import { agentCardRoutes } from "./agent-card";
import { consumerReadRoutes } from "./consumer-reads";
import { discordRoutes } from "./discord-routes";
import { mcpJsonRpcRoutes } from "./mcp-jsonrpc";
import { policyRoutes } from "./policy-routes";
import { realJobDeps } from "./job-wiring";
import { buildPaidSurface } from "./paid-routes";
import { recordSale } from "./sales";
import { stage1Fallback, stage1Routes, type Stage1Settlement } from "./stage1-routes";
import type { Route } from "./router";
import type { WorkerEnv } from "./env";
import type { JobDeps } from "./jobs";
import type { WriterGate } from "./writer-gate";

const MIGRATIONS: readonly string[] = [
  "001_init.sql", "002_policies.sql", "003_escalations.sql", "004_operators.sql",
  "005_verify_provenance.sql", "006_score_snapshots.sql", "007_consumer_pack.sql",
  "008_cross_rail_clearing.sql", "009_consumer_auth.sql", "010_capability_access_blocker.sql",
  "011_solana_proof_gate.sql", "012_settlement_account_registration.sql",
  "013_capability_execution_shape.sql", "014_delivery_verification.sql", "015_untch_accounts.sql",
  "016_account_linking.sql", "017_approval_requests.sql", "018_activity_index.sql",
  "019_agentic_wallet_binding.sql", "020_decision_evidence.sql", "021_snapshot_audit_annotation.sql",
  "022_artifact_audit_annotation.sql", "023_validation_leak_quarantine.sql",
  "024_wallet_account_permanence.sql", "025_decision_evidence_v3_requester.sql",
  "026_durable_decision_state.sql", "027_budget_reservations.sql",
  "028_x402_service_calls_and_approval_activation.sql", "029_approval_channels_actions_lineage.sql",
  "030_bound_approval_actions.sql", "031_requote_lineage.sql", "032_approval_oauth_state.sql",
  "033_approval_oauth_smoke.sql", "034_discord_dm_binding_repair.sql",
  "035_wallet_scope_downgrade.sql", "036_marketplace_sales.sql", "037_spend_intents.sql",
];

/**
 * Nothing mutating is wired yet.
 *
 * Each job body will call its canonical module once the routes are ported. Until then they return 0,
 * and the writer gate refuses them anyway — so a scheduled tick on a preview provably does nothing.
 */
const noopJobDeps = (_pool: pg.Pool, gate: WriterGate): JobDeps => ({
  gate,
  reconcileServiceCalls: async () => 0,
  projectDeliveries: async () => 0,
  recoverUnpublishedDeliveries: async () => 0,
  deliverQueued: async () => 0,
  expireApprovals: async () => 0,
  expireReservations: async () => 0,
  recoverAbandonedActions: async () => 0,
  reconcileReceipts: async () => 0,
  observeTreasury: async () => 0,
  snapshotOperationalHealth: async () => 0,
});

/**
 * What the x402 document publishes as the settlement target.
 *
 * `PAY_TO_ADDRESS` is read from the environment rather than hardcoded, and its absence is fatal to
 * the discovery documents rather than papered over with a zero address: publishing `0x000…0` as the
 * payee would tell a paying client to send USDT0 into a burn.
 */
function settlement(env: WorkerEnv): Stage1Settlement {
  const payTo = (env as unknown as { PAY_TO_ADDRESS?: string }).PAY_TO_ADDRESS?.trim();
  if (!payTo) throw new Error("PAY_TO_ADDRESS is not configured; the x402 document would name no payee");
  return {
    network: NETWORK,
    payTo,
    asset: {
      symbol: SETTLEMENT_TOKEN.symbol,
      address: SETTLEMENT_TOKEN.address,
      decimals: SETTLEMENT_TOKEN.decimals,
    },
  };
}

/**
 * The paid surface, built only when this deployment can actually settle.
 *
 * The OKX facilitator credentials are wrangler secrets. Without them the resource server cannot
 * verify an authorization or settle one, so the six paid routes are not registered at all and fall to
 * the 503 — which says the endpoint is real and unavailable. Registering them anyway would emit a 402
 * this deployment could never honour, inviting a caller to pay for work it cannot complete.
 *
 * Memoised per isolate: the facilitator client and the resource server are the same for every request
 * an isolate serves, and rebuilding them per request would add a handshake to each paid call.
 */
let paidSurface: ReturnType<typeof buildPaidSurface> | null | undefined;


function paid(ctx: RouteContext): ReturnType<typeof buildPaidSurface> | null {
  if (paidSurface !== undefined) return paidSurface;
  const env = ctx.env;
  const apiKey = env.OKX_API_KEY?.trim();
  const secretKey = env.OKX_SECRET_KEY?.trim();
  const passphrase = env.OKX_PASSPHRASE?.trim();
  if (!apiKey || !secretKey || !passphrase) {
    paidSurface = null;
    return null;
  }
  paidSurface = buildPaidSurface({
    payTo: settlement(ctx.env).payTo,
    publicBaseUrl: ctx.baseUrl,
    okx: { apiKey, secretKey, passphrase },
    arming: () => ctx.arming,
  });
  return paidSurface;
}

/**
 * The account-scoped reads, wired only when this deployment can verify a session.
 *
 * Without `CONSUMER_AUTH_SECRET` no bearer token can be opened, so every one of these routes would
 * answer 401 to a legitimate caller. Leaving them unregistered lets the fallback say the honest thing
 * instead — the endpoint is real and this deployment cannot serve it.
 */
function consumerRoutes(ctx: RouteContext): readonly Route[] {
  const secret = ctx.env.CONSUMER_AUTH_SECRET?.trim();
  if (!secret) return [];
  return [
    ...consumerReadRoutes({ pool: ctx.pool, secret, gate: ctx.gate, executionEnabled: false }),
    /**
     * Policy registration shares the session secret, and it is the HEAD of the pipeline: without it a
     * caller can never obtain the registered policy that `create_spend_intent`, `preflight_payment`
     * and `verify_delivery` all require.
     */
    ...policyRoutes({ pool: ctx.pool, secret, gate: ctx.gate }),
  ];
}

/**
 * The Discord interaction endpoint, wired only with a public key to verify against.
 *
 * Without `DISCORD_PUBLIC_KEY` no signature can be checked, and an endpoint that cannot verify must
 * not answer at all — Discord would take a 2xx as proof the endpoint is healthy.
 */
function discord(ctx: RouteContext): readonly Route[] {
  const publicKeyHex = ctx.env.DISCORD_PUBLIC_KEY?.trim();
  if (!publicKeyHex) return [];
  return discordRoutes({ publicKeyHex, log: (line) => console.log(line) });
}

/**
 * MCP JSON-RPC, which is how the OKX client discovers tools and their input schemas.
 *
 * `tools/call` re-enters the SAME route this Worker already serves — payment gate included — rather
 * than calling a handler directly. A second path to a paid tool would be a second place for the
 * payment decision to diverge.
 */
function mcp(ctx: RouteContext, routesOf: (c: RouteContext) => readonly Route[]): readonly Route[] {
  return mcpJsonRpcRoutes({
    baseUrl: ctx.baseUrl,
    callTool: async (path, method, body, asTool, req) => {
      const table = routesOf(ctx);
      const target = table.find((r) => r.pattern === path && r.method === method);
      if (!target) {
        return new Response(
          JSON.stringify({ code: "SERVICE_TEMPORARILY_UNAVAILABLE", message: `${method} ${path} is not served here yet` }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const run = () => Promise.resolve(target.handler({ ...req, request: asTool, body, params: {} }));
      const gate = target.priced ? paymentGateFor(ctx) : undefined;
      return gate ? gate(asTool, body, run) : run();
    },
  });
}

/** The gate a priced tool must pass, built once here so the HTTP and MCP paths share it exactly. */
function paymentGateFor(ctx: RouteContext) {
  const gate = paid(ctx)?.gate;
  if (!gate) return undefined;
  return (request: Request, body: unknown, run: () => Promise<Response>) =>
    gate(request, body, run, (facts) => recordSale(ctx.pool, facts));
}

function allRoutes(ctx: RouteContext): readonly Route[] {
  return [
    ...stage1Routes(ctx, settlement(ctx.env)),
    ...(paid(ctx)?.routesFor(ctx.pool) ?? []),
    ...consumerRoutes(ctx),
    ...discord(ctx),
    ...agentCardRoutes(ctx.baseUrl),
    ...mcp(ctx, httpRoutes),
  ];
}

/** The HTTP table WITHOUT the MCP routes, so tools/call cannot recurse into itself. */
function httpRoutes(ctx: RouteContext): readonly Route[] {
  return [
    ...stage1Routes(ctx, settlement(ctx.env)),
    ...(paid(ctx)?.routesFor(ctx.pool) ?? []),
    ...consumerRoutes(ctx),
  ];
}

const worker = buildWorker({
  /**
   * Three connections, not five.
   *
   * The pool is per-request — a Worker cannot reuse an I/O object across request contexts — so `max`
   * multiplies by concurrency rather than bounding the process. At five, fifteen concurrent requests
   * could ask the origin for seventy-five connections against a Hyperdrive budget of sixty, and three
   * of fifteen failed. Three is enough for the widest fan-out any single handler does (the account read
   * runs three queries together) and keeps a burst inside the budget.
   */
  makePool: (connectionString) => new pg.Pool({ connectionString, max: 3 }) as never,
  expectedMigrations: MIGRATIONS,
  jobDeps: realJobDeps as never,
  routes: allRoutes,
  onUnmatched: stage1Fallback,
  /**
   * The gate is memoised; where a sale is recorded is not. The pool belongs to the request in flight,
   * so it is handed to the gate per call rather than captured when the gate was built.
   */
  paymentGate: paymentGateFor,
});

export default {
  /**
   * `ctx` is Cloudflare's execution context, typed structurally rather than pulled from
   * `@cloudflare/workers-types`. The ambient global is not in this package's tsconfig, and naming it
   * compiled locally only because the ROOT tsconfig covers `packages/**` and `scripts/**` but not
   * `services/**` — so the failure surfaced in CI rather than here. Only `waitUntil` is used.
   */
  fetch: (request: Request, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }) =>
    worker.fetch(request, env, ctx),
  queue: (batch: never, env: WorkerEnv) => worker.queue(batch, env),
  scheduled: (event: { cron: string }, env: WorkerEnv) => worker.scheduled(event, env),
};
