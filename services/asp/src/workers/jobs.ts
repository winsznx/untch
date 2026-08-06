/**
 * The concrete scheduled jobs, wired from the loops the Node deployment actually ran.
 *
 * WHERE THESE CAME FROM
 *
 * Not invented. Each one replaces a specific `setInterval` in the running service:
 *
 *   consumer/approval-lifecycle.ts  reconcile pass (30s), delivery pass
 *   consumer/wiring.ts              outbox dispatch (1s), execution drain (2s), treasury observation
 *   escalation/timeout-worker.ts    escalation timeout sweep
 *   receipt-writer/worker.ts        receipt batch tick
 *
 * Two of them were never timers and are new because Workers needs them to be: outbox PUBLICATION
 * recovery, which on Railway was implicit in the delivery poll, and the operational-health snapshot,
 * which on Railway was in-process state that died with the container.
 *
 * EVERY JOB IS GATED TWICE
 *
 * `assertOwnsWrites` before any mutation, because Railway owns production writes until cutover. The
 * financial arming gate is separate and narrower — reconciliation is not a financial authorisation, so
 * arming would not have stopped these. Both gates are consulted; a mutation needs both.
 *
 * A job whose mutation is refused still SUCCEEDS. Before cutover, refusing is correct, and a job that
 * failed for behaving correctly would make the health signal useless exactly when it matters.
 */

import type { Pool } from "@untch/consumer-core";
import type { ScheduledJob, JobContext } from "./scheduled";
import { ifOwnsWrites, type GatedMutation, type WriterGate } from "./writer-gate";

/**
 * What a job needs from the outside world.
 *
 * Injected rather than imported so a job can be exercised without a facilitator, a Discord token or a
 * Solana RPC — and so the wiring is visible in one place rather than hidden in module scope.
 */
export interface JobDeps {
  readonly gate: WriterGate;
  readonly reconcileServiceCalls: (pool: Pool, limit: number) => Promise<number>;
  readonly projectDeliveries: (pool: Pool, limit: number) => Promise<number>;
  readonly recoverUnpublishedDeliveries: (pool: Pool, limit: number) => Promise<number>;
  readonly deliverQueued: (pool: Pool, limit: number) => Promise<number>;
  readonly expireApprovals: (pool: Pool, limit: number) => Promise<number>;
  readonly expireReservations: (pool: Pool, limit: number) => Promise<number>;
  readonly recoverAbandonedActions: (pool: Pool, limit: number) => Promise<number>;
  readonly reconcileReceipts: (pool: Pool, limit: number) => Promise<number>;
  readonly observeTreasury: (pool: Pool, limit: number) => Promise<number>;
  readonly snapshotOperationalHealth: (pool: Pool, limit: number) => Promise<number>;
}

/** One job definition, with the mutation it is gated on stated rather than implied. */
function gatedJob(
  name: string,
  cron: string,
  limit: number,
  mutation: GatedMutation,
  body: (pool: Pool, limit: number) => Promise<number>,
  gate: WriterGate,
): ScheduledJob {
  return {
    name,
    cron,
    limit,
    run: async (ctx: JobContext): Promise<number> => {
      const out = await ifOwnsWrites(gate, mutation, () => body(ctx.pool, ctx.limit));
      if (!out.ran) {
        ctx.log(`[jobs] ${name}: refused ${out.refused} — another deployment owns production writes`);
        return 0;
      }
      return out.result;
    },
  };
}

/**
 * The ten jobs.
 *
 * Cadences follow the Node intervals where one existed. The fast loops are deliberately NOT ported at
 * their original frequency: a 1-second `setInterval` inside a long-lived process becomes a Cron
 * Trigger that cannot fire faster than once a minute, and the Queue is what makes delivery prompt now.
 * The sweeps are the safety net, not the primary path, so a minute is the right resolution for them.
 */
export function buildJobs(deps: JobDeps): readonly ScheduledJob[] {
  const g = deps.gate;
  return [
    // Was: approval-lifecycle reconcile pass, every 30s. Each call commits in its own transaction, so
    // one unresolvable call cannot roll back work that already succeeded.
    gatedJob("payment-reconciliation", "* * * * *", 20, "payment-reconciliation-write", deps.reconcileServiceCalls, g),

    // Was: the same pass. Split out because finalisation and payment state fail for different reasons
    // and a combined job would report one number for two questions.
    gatedJob("service-call-reconciliation", "* * * * *", 20, "service-call-finalisation-write", deps.reconcileServiceCalls, g),

    // Was: approval-lifecycle delivery pass. The Queue now carries the fast path; this catches
    // anything the Queue did not.
    gatedJob("delivery-recovery", "* * * * *", 50, "delivery-claim", deps.deliverQueued, g),

    // NEW. On Railway, publication was implicit in the delivery poll. With a Queue, a publish can fail
    // after the row commits, and without this the delivery would wait for the next poll that no longer
    // exists.
    gatedJob("outbox-publication-recovery", "* * * * *", 100, "outbox-recovery-publication", deps.recoverUnpublishedDeliveries, g),

    // Was: part of the delivery pass — outbox rows becoming delivery rows.
    gatedJob("delivery-projection", "* * * * *", 100, "delivery-publication", deps.projectDeliveries, g),

    gatedJob("approval-expiry", "*/5 * * * *", 100, "approval-expiry-mutation", deps.expireApprovals, g),

    // Was: expireStaleReservations. Bookkeeping rather than enforcement — budgetExposure already
    // excludes expired holds by date — but the stored status has to stop lying to anyone reading rows.
    gatedJob("reservation-expiry", "*/5 * * * *", 100, "reservation-expiry-mutation", deps.expireReservations, g),

    // Was: escalation timeout-worker sweep.
    gatedJob("abandoned-action-recovery", "*/5 * * * *", 50, "approval-expiry-mutation", deps.recoverAbandonedActions, g),

    // Was: receipt-writer worker tick.
    gatedJob("receipt-reconciliation", "*/5 * * * *", 25, "receipt-persistence", deps.reconcileReceipts, g),

    // Was: consumer/wiring treasury observation. This is the append-only table measured growing on
    // Railway at roughly one row per 45 seconds.
    gatedJob("treasury-observation", "*/5 * * * *", 10, "treasury-observation-persistence", deps.observeTreasury, g),

    // NEW. On Railway this was in-process state that died with the container, so nothing outlived a
    // restart to say whether the sweeps had been running.
    gatedJob("operational-health-snapshot", "*/5 * * * *", 1, "operational-snapshot-row", deps.snapshotOperationalHealth, g),
  ];
}

/** Cron expressions the Worker must declare. Derived from the jobs so config cannot drift from code. */
export function requiredCrons(jobs: readonly ScheduledJob[]): readonly string[] {
  return [...new Set(jobs.map((j) => j.cron))].sort();
}
