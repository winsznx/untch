import type { Hex } from "viem";
import { createPool, PgPolicyRepo, type Pool } from "@untch/policy-store";
import { PgReportDataSource } from "@untch/reports";
import { PgEscalationsRepo } from "@untch/escalation";
import { PgScoreDataSource } from "@untch/trust-bureau";

/**
 * The dashboard's READ connection to the SAME shared Railway Postgres the seller (`@untch/asp`), the
 * receipt writer, the escalation service, and the Bureau write to in production — the exact `DATABASE_URL`
 * confirmed on the untch-asp service (`postgres.railway.internal`). This is what makes the dashboard show
 * the reality a real agent sees instead of a seeded copy: every read here goes through the SAME proven pg
 * repos those services use (`PgPolicyRepo`, `PgReportDataSource`, `PgEscalationsRepo`, `PgScoreDataSource`),
 * never a second query implementation.
 *
 * `pg` stays a server-only external (see next.config.ts) — this module is `server-only`, so it can never be
 * pulled into a client bundle. When `DATABASE_URL` is unset (local dev / CI without the shared DB), `getPool`
 * returns null and every scoped read resolves to an honest empty state rather than throwing.
 *
 * The write path is unchanged: policy/vault writes are still the connected wallet signing a transaction
 * straight to chain (see components/wallet/*). This module only reads.
 */

declare global {
  // eslint-disable-next-line no-var
  var __untchDbPool: Pool | null | undefined;
}

/** The shared read pool (memoised on globalThis so Next hot-reload / serverless reuse doesn't leak pools). */
export function getPool(): Pool | null {
  if (globalThis.__untchDbPool !== undefined) return globalThis.__untchDbPool;
  const url = process.env.DATABASE_URL?.trim();
  globalThis.__untchDbPool = url ? createPool(url) : null;
  return globalThis.__untchDbPool;
}

export function policyRepo(pool: Pool): PgPolicyRepo {
  return new PgPolicyRepo(pool);
}
export function reportSource(pool: Pool): PgReportDataSource {
  return new PgReportDataSource(pool);
}
export function escalationRepo(pool: Pool): PgEscalationsRepo {
  return new PgEscalationsRepo(pool);
}
export function scoreSource(pool: Pool): PgScoreDataSource {
  return new PgScoreDataSource(pool);
}

/**
 * The agents an operator governs — the scoping bridge. A dashboard user signs in as a wallet (the policy
 * `owner` / on-chain registrant); receipts, ledger, escalations, and scores are all keyed by `agent_id`, so
 * every scoped read resolves the owner's agents from the `policies` table first, then reads per agent. An
 * owner with no policies has no agents → empty everywhere (never a global unscoped read).
 */
export async function ownerAgents(pool: Pool, owner: string): Promise<Hex[]> {
  const policies = await policyRepo(pool).listByOwner(owner);
  const ids = new Set<string>();
  for (const p of policies) ids.add(p.agentId.toLowerCase());
  return [...ids] as Hex[];
}

/** A read window wide enough to cover all of an operator's history; reads take [fromIso, toIso). */
export const READ_WINDOW_FROM = "2020-01-01T00:00:00.000Z";
export function readWindowTo(): string {
  return new Date(Date.now() + 24 * 60 * 60_000).toISOString();
}
