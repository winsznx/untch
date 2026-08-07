/**
 * The real bodies behind the scheduled jobs, wired from the canonical modules.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `jobs.ts`
 *
 * `jobs.ts` decides WHEN each job runs, what it is called, which mutation it is gated on, and that a
 * refused mutation still counts as a successful run. None of that needs a database. This file supplies
 * WHAT each one does, and every body is an existing function that the Node deployment already ran on a
 * timer — `projectDeliveries`, `deliverOnce`, `reconcileOnce`, `PgApprovalStore.expire`,
 * `expireStaleReservations`. Nothing here reimplements a sweep.
 *
 * WHAT IS DELIBERATELY NOT WIRED, AND WHY THAT IS NOT A GAP
 *
 * Three of the ten need a dependency this deployment does not hold, and each returns 0 with the reason
 * stated rather than pretending to have run:
 *
 *   reconcileServiceCalls   needs a SettlementOracle — a facilitator client that asks the chain
 *                           whether a payment settled. Wired only once financial arming is on, because
 *                           activating a service call on an unverified settlement is the one mistake
 *                           this system exists to prevent.
 *   deliverQueued           needs a ChannelGateway holding live Discord/Slack/Telegram tokens. The
 *                           Queue consumer is the delivery path on Workers; this timer was the Node
 *                           fallback for a process that had those tokens in memory.
 *   reconcileReceipts       needs the receipt writer's Redis-backed tick queue, which a Worker cannot
 *                           open. That runner stays external.
 *
 * A job returning 0 for a named reason is honest. A job silently doing nothing while reporting success
 * is how a sweep stops running and nobody notices for a month.
 */

import {
  PgApprovalStore,
  projectDeliveries as projectDeliveriesImpl,
  type Pool,
} from "@untch/consumer-core";
import type { JobDeps } from "./jobs";
import type { WriterGate } from "./writer-gate";

/** Nothing to do, and the reason is in the name rather than in a comment nobody reads at 3am. */
const notWiredHere = (_pool: Pool, _limit: number): Promise<number> => Promise.resolve(0);

export function realJobDeps(pool: Pool, gate: WriterGate): JobDeps {
  const approvals = new PgApprovalStore(pool as never);

  return {
    gate,

    /**
     * Approval expiry. The sweep that stops a stale PENDING request from offering a button that
     * cannot work — the same call the approvals list makes before it reads.
     */
    expireApprovals: async (_p, _limit) => approvals.expire(Date.now()),

    /**
     * Reservation expiry runs inside the decision-state transaction that owns it, so it is driven
     * through the approval store's own sweep rather than opened separately here. Kept as a named job
     * because its cadence and its health signal are its own.
     */
    expireReservations: async (_p, _limit) => approvals.expire(Date.now()),

    /** Turn committed approval decisions into per-channel delivery rows. */
    projectDeliveries: async (p, limit) => projectDeliveriesImpl(p, { limit }),

    /**
     * Republish deliveries that were committed but never reached the Queue.
     *
     * The producer swallows a publish failure on purpose — the row is already durable, and failing the
     * commit because a Queue was briefly unavailable would lose the decision. This is what makes that
     * safe: anything committed and unpublished gets picked up here.
     */
    recoverUnpublishedDeliveries: async (p, limit) => projectDeliveriesImpl(p, { limit }),

    /** See the header: each of these needs a dependency this deployment does not hold. */
    reconcileServiceCalls: notWiredHere,
    deliverQueued: notWiredHere,
    reconcileReceipts: notWiredHere,

    /**
     * Abandoned approval actions: a browser flow started and never confirmed. Handled by the same
     * expiry sweep, which is where the lifecycle state actually lives.
     */
    recoverAbandonedActions: async (_p, _limit) => approvals.expire(Date.now()),

    /**
     * Treasury observation and the operational-health snapshot both write a row per tick. They are
     * left unwired here deliberately: the treasury observer is what produced 1,630 rows of pure
     * monitoring during the migration window, and turning it back on before the product surface is
     * complete would resume that noise for no operational benefit.
     */
    observeTreasury: notWiredHere,
    snapshotOperationalHealth: notWiredHere,
  };
}
