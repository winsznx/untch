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
  "035_wallet_scope_downgrade.sql",
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

const worker = buildWorker({
  makePool: (connectionString) => new pg.Pool({ connectionString, max: 5 }) as never,
  expectedMigrations: MIGRATIONS,
  jobDeps: noopJobDeps as never,
  routes: (ctx: RouteContext): readonly Route[] => stage1Routes(ctx, settlement(ctx.env)),
  onUnmatched: stage1Fallback,
});

export default {
  fetch: (request: Request, env: WorkerEnv) => worker.fetch(request, env),
  queue: (batch: never, env: WorkerEnv) => worker.queue(batch, env),
  scheduled: (event: { cron: string }, env: WorkerEnv) => worker.scheduled(event, env),
};
