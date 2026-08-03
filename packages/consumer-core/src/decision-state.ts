/**
 * The state a decision reads, and the only place it is written.
 *
 * WHY THIS IS NOT A `Ledger` IMPLEMENTATION
 *
 * `@untch/policy-engine`'s `Ledger` has `read` and `commitApproved`, and `commitApproved` is called by
 * the engine, inside the engine's lock, with no transaction in sight. That shape is what let a
 * rolled-back validation change a later decision: the commit happened somewhere the caller could not
 * reach to undo it.
 *
 * So this is deliberately a different shape. `snapshot(tx, …)` READS. `commit(tx, effects)` WRITES.
 * Both take the caller's transaction, and there is no method that does both. A caller that reads a
 * snapshot, evaluates, and never calls `commit` has mutated nothing — not because it passed a flag,
 * but because it did not call the function that writes.
 *
 * WHY THE LOCK IS AN ADVISORY XACT LOCK
 *
 * `pg_advisory_xact_lock` is held for the caller's transaction and released by COMMIT or ROLLBACK, by
 * the database. The in-process mutex it replaces could not serialise two replicas and could leak a
 * held lock if a request died mid-flight. This can do neither.
 *
 * The lock is taken on the PARTITION KEY — `policy:<policyId>` — so two intents under one policy
 * serialise while unrelated policies proceed in parallel.
 */

import type { DecisionEffects, LedgerWindowState, RecentIntent } from "@untch/policy-engine";
import { budgetExposure } from "./budget-reservation";
import type { Hex } from "viem";

/** The transaction handle every method takes. Same shape the evidence writer uses. */
export interface DecisionStateTx {
  query(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: unknown[] }>;
}

const HOUR_MS = 60 * 60 * 1000;
/** Older recent-intent rows cannot affect any sane duplicate TTL, and reading them costs time. */
const RECENT_INTENT_WINDOW_MS = 24 * HOUR_MS;

/**
 * Take the partition lock for the rest of this transaction.
 *
 * `hashtextextended` gives a stable 64-bit key from the partition string. A hash collision would
 * serialise two unrelated policies — slower, never incorrect — which is the right direction for a
 * lock to be wrong in.
 */
export async function lockPartition(tx: DecisionStateTx, partitionKey: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [partitionKey]);
}

interface RecentRow {
  intent_id: string;
  task_hash: string;
  endpoint: string;
  params_hash: string;
  max_amount: string | null;
  recipient_address: string | null;
  category: string | null;
  created_at_ms: string;
}

/**
 * Read the window the engine evaluates against.
 *
 * `nowMs` is a parameter rather than a `now()` in SQL so a decision and its evidence agree on when
 * they happened. Two clocks — the app's and the database's — is two answers to "was this within the
 * TTL", and the difference only shows up at the boundary, which is exactly where it matters.
 */
export async function snapshotDecisionState(
  tx: DecisionStateTx,
  partitionKey: string,
  nowMs: number,
  dayKey: string,
): Promise<LedgerWindowState> {
  const recent = (await tx.query(
    `SELECT intent_id, task_hash, endpoint, params_hash, max_amount, recipient_address, category,
            created_at_ms::text AS created_at_ms
       FROM untch_decision_recent_intents
      WHERE partition_key = $1 AND created_at_ms > $2
      ORDER BY created_at_ms DESC
      LIMIT 500`,
    [partitionKey, nowMs - RECENT_INTENT_WINDOW_MS],
  )) as { rows: RecentRow[] };

  const recentIntents: RecentIntent[] = recent.rows.map((r) => ({
    intentId: r.intent_id,
    taskHash: r.task_hash as Hex,
    endpoint: r.endpoint,
    paramsHash: r.params_hash as Hex,
    createdAtMs: Number(r.created_at_ms),
    ...(r.max_amount !== null ? { maxAmount: r.max_amount } : {}),
    ...(r.recipient_address !== null ? { recipientAddress: r.recipient_address as Hex } : {}),
    ...(r.category !== null ? { category: r.category } : {}),
  })) as RecentIntent[];

  /**
   * Settled money and still-executable authority, read separately.
   *
   * This replaced a single `untch_decision_daily_spend` counter that summed the governed amounts of
   * APPROVED decisions and was named, traced and rendered as spend. Nothing had been paid: the
   * preflight route is decision-only. Reservations make the same capacity visible to the next
   * decision — so two agents still cannot over-authorise one account — without calling it spend.
   */
  const usage = await budgetExposure(tx, partitionKey, dayKey, new Date(nowMs).toISOString());

  const calls = (await tx.query(
    "SELECT count(*)::text AS n FROM untch_decision_rate_ticks WHERE partition_key = $1 AND called_at_ms > $2",
    [partitionKey, nowMs - HOUR_MS],
  )) as { rows: { n: string }[] };

  const services = (await tx.query(
    "SELECT service_host, last_called_ms::text AS last_called_ms FROM untch_decision_service_calls WHERE partition_key = $1",
    [partitionKey],
  )) as { rows: { service_host: string; last_called_ms: string }[] };

  const lastCallByService: Record<string, number> = {};
  for (const s of services.rows) lastCallByService[s.service_host] = Number(s.last_called_ms);

  return {
    budgetUsage: usage,
    recentIntents,
    lastCallByService,
    callsInLastHour: Number(calls.rows[0]?.n ?? 0),
  };
}

/**
 * Apply a decision's proposed effects. Every write in one transaction, the caller's.
 *
 * The replay marker is inserted WITHOUT `ON CONFLICT DO NOTHING`, on purpose. A conflict means this
 * exact intent hash has already been committed under this partition — two concurrent identical
 * requests reaching commit — and the correct outcome is that the second one fails loudly rather than
 * quietly recording a second duplicate marker for work that happened once.
 */
export async function commitDecisionEffects(tx: DecisionStateTx, effects: DecisionEffects): Promise<void> {
  const p = effects.partitionKey;

  await tx.query(
    `INSERT INTO untch_decision_replay_markers (partition_key, intent_hash) VALUES ($1, $2)`,
    [p, effects.replay.intentHash],
  );

  const r = effects.duplicate.recentIntent;
  await tx.query(
    `INSERT INTO untch_decision_recent_intents
       (partition_key, intent_id, intent_hash, task_hash, endpoint, params_hash,
        max_amount, recipient_address, category, created_at_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      p,
      r.intentId,
      effects.replay.intentHash,
      r.taskHash,
      r.endpoint,
      r.paramsHash,
      r.maxAmount ?? null,
      r.recipientAddress ?? null,
      r.category ?? null,
      r.createdAtMs,
    ],
  );

  /**
   * NO SPEND COUNTER IS INCREMENTED HERE.
   *
   * An approved decision grants authority; it does not move money. The budget capacity it consumes is
   * recorded as a RESERVATION by the caller, in this same transaction — see `createReservation`. The
   * counter this used to increment was called spend, and the ledger, the reports and the dashboard
   * all believed it.
   */

  await tx.query(
    "INSERT INTO untch_decision_rate_ticks (partition_key, called_at_ms) VALUES ($1,$2)",
    [p, effects.rate.atMs],
  );

  await tx.query(
    `INSERT INTO untch_decision_service_calls (partition_key, service_host, last_called_ms)
     VALUES ($1,$2,$3)
     ON CONFLICT (partition_key, service_host)
       DO UPDATE SET last_called_ms = GREATEST(untch_decision_service_calls.last_called_ms, EXCLUDED.last_called_ms)`,
    [p, effects.cooldown.serviceHost, effects.cooldown.atMs],
  );
}

/** Counts a test or an operator can assert on, per partition. */
export async function decisionStateCounts(
  tx: DecisionStateTx,
  partitionKey: string,
): Promise<{
  readonly recentIntents: number;
  readonly rateTicks: number;
  readonly replayMarkers: number;
  readonly serviceCalls: number;
  /** Authority granted and still executable. NOT money. */
  readonly activeReserved: string;
  /** Money that actually moved for a governed spend. Zero while preflight stays decision-only. */
  readonly settledSpend: string;
}> {
  const one = async (sql: string): Promise<string> =>
    String(((await tx.query(sql, [partitionKey])) as { rows: { n: string }[] }).rows[0]?.n ?? "0");

  return {
    recentIntents: Number(await one("SELECT count(*)::text n FROM untch_decision_recent_intents WHERE partition_key = $1")),
    rateTicks: Number(await one("SELECT count(*)::text n FROM untch_decision_rate_ticks WHERE partition_key = $1")),
    replayMarkers: Number(await one("SELECT count(*)::text n FROM untch_decision_replay_markers WHERE partition_key = $1")),
    serviceCalls: Number(await one("SELECT count(*)::text n FROM untch_decision_service_calls WHERE partition_key = $1")),
    activeReserved: await one(
      "SELECT coalesce(sum(amount),0)::text n FROM untch_budget_reservations WHERE partition_key = $1 AND status = 'ACTIVE'"),
    settledSpend: await one(
      "SELECT coalesce(sum(amount),0)::text n FROM untch_settled_spend WHERE partition_key = $1"),
  };
}
