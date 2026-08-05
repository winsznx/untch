import type { NextFunction, Request, Response } from "express";
import {
  PgServiceCallStore,
  deliverOnce,
  finalizeSettlement,
  projectDeliveries,
  reconcileOnce,
  SettlementEvidenceError,
  type ChannelGateway,
  type Pool,
  type SettlementOracle,
} from "@untch/consumer-core";
import { rawPaymentAuthorizationHeader } from "./payment-authorization";

/**
 * The two things that make an approval actionable, and the loop that finishes the job when neither ran.
 *
 * THE RULE EVERYTHING HERE OBEYS
 *
 *     facilitator accepted is not settlement confirmed
 *
 * `processSettlement` returns `success: true` for a PENDING settlement as well as a confirmed one, and
 * a pending settlement emits a real settlement header and a real 2xx. So none of these may activate an
 * approval:
 *
 *   HTTP 2xx · a settlement response header · processSettlement success · facilitator status pending ·
 *   the handler committing · the response finishing
 *
 * Only an authority saying `success` about a named transaction may. That authority is
 * `getSettleStatus`, reached through `facilitatorOracle`, and the only writer is `finalizeSettlement`.
 *
 * WHY `finish` IS STILL WORTH HOOKING
 *
 * Because it is fast, and a human waiting on a Discord message should not wait for a polling interval.
 * It is an OPTIMISATION and never a correctness boundary: the process can die before it fires, after it
 * fires and before the finalizer commits, or after the commit and before the client is answered. The
 * reconciler below is what actually protects the money, and it is safe to run forever on every replica.
 */

export const APPROVAL_WORKER_HEALTH_ROUTE = "/internal/consumer/approval-workers" as const;

export interface ApprovalLifecycleDeps {
  readonly pool: Pool;
  readonly oracle: SettlementOracle;
  readonly gateway: ChannelGateway;
  /** The priced routes whose responses may carry a settlement worth finalizing. */
  readonly routes: readonly string[];
  readonly reconcileIntervalMs?: number;
  readonly deliverIntervalMs?: number;
  readonly log?: (line: string) => void;
}

export interface WorkerHealth {
  readonly name: string;
  readonly running: boolean;
  readonly passes: number;
  readonly lastRunAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
}

class Health {
  passes = 0;
  lastRunAt: string | null = null;
  lastErrorAt: string | null = null;
  lastError: string | null = null;
  consecutiveFailures = 0;
  running = false;

  ok(): void {
    this.passes += 1;
    this.lastRunAt = new Date().toISOString();
    this.consecutiveFailures = 0;
  }

  fail(err: unknown): void {
    this.lastErrorAt = new Date().toISOString();
    this.lastError = (err as Error).message.slice(0, 300);
    this.consecutiveFailures += 1;
  }

  report(name: string): WorkerHealth {
    return {
      name,
      running: this.running,
      passes: this.passes,
      lastRunAt: this.lastRunAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

/**
 * Finalize on the way out, when there is authoritative evidence to finalize with.
 *
 * Mounted OUTSIDE `paymentMiddleware`, like the observer, so it sees the settlement headers the
 * middleware attached. It changes no payment behaviour: it reads, it asks the facilitator, and it
 * writes approval state. Nothing here can prevent, delay, retry or trigger a settlement.
 *
 * The correlation is done through the authorization NONCE rather than through anything the handler
 * passes down. The nonce is what the attempt row is keyed on and what the facilitator settles against,
 * so a lookup by nonce is the same identity the finalizer will compare terms on — and it keeps this
 * middleware independent of whether the handler remembered to stash an id somewhere.
 */
export function finalizeSettledApprovals(deps: {
  readonly pool: Pool;
  readonly oracle: SettlementOracle;
  readonly routes: readonly string[];
  readonly log?: (line: string) => void;
}) {
  const watched = new Set(deps.routes);
  const store = new PgServiceCallStore(deps.pool);
  const log = deps.log ?? ((line: string) => console.log(line));

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!watched.has(req.path)) return next();
    const raw = rawPaymentAuthorizationHeader(req);
    if (!raw) return next();

    res.on("finish", () => {
      /**
       * A non-2xx never settles, so there is nothing to finalize and asking would be a pointless round
       * trip to the facilitator on every refusal. This is the same property the 503 approval gate
       * depends on, read from the other side.
       */
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      void (async () => {
        try {
          const nonce = nonceOf(raw);
          if (!nonce) return;

          const attempt = await store.attemptByNonce(nonce);
          if (!attempt) return;

          /**
           * The hash comes from the attempt row when the middleware already recorded one, and from the
           * response header otherwise. The header is where the facilitator names the transaction it
           * submitted, and without a hash there is nothing to ask about — `facilitatorOracle` answers
           * UNKNOWN and the reconciler tries again later.
           */
          const evidence = await deps.oracle.settlementFor({
            terms: {
              authorizationNonce: attempt.authorizationNonce,
              payer: attempt.payer,
              token: attempt.token,
              amount: attempt.amount,
              payTo: attempt.payTo,
              chain: attempt.chain,
            },
            transactionHash: attempt.transactionHash ?? settlementTransactionHash(res),
            paymentId: attempt.paymentId,
          });

          const client = await deps.pool.connect();
          try {
            await client.query("BEGIN");
            const result = await finalizeSettlement(client, {
              serviceCallId: attempt.serviceCallId,
              evidence,
            });
            await client.query("COMMIT");
            log(
              `[approval-finalizer] ${JSON.stringify({
                serviceCallId: attempt.serviceCallId,
                evidence: evidence.kind,
                outcome: result.outcome,
                approvalRequestId: result.approvalRequestId,
                outboxEventId: result.outboxEventId,
              })}`,
            );
          } catch (err) {
            await client.query("ROLLBACK").catch(() => undefined);
            const detail = err instanceof SettlementEvidenceError ? `${err.code}: ${err.message}` : (err as Error).message;
            log(`[approval-finalizer] refused ${attempt.serviceCallId}: ${detail}`);
          } finally {
            client.release();
          }
        } catch {
          /**
           * A finalizer that can break a request is worse than one that misses a pass. The reconciler
           * reaches the same state from committed data, so a failure here costs latency and never
           * correctness.
           */
        }
      })();
    });

    next();
  };
}

const SETTLEMENT_HEADERS = ["payment-response", "x-payment-response", "payment-receipt"] as const;

function settlementTransactionHash(res: Response): string | null {
  for (const name of SETTLEMENT_HEADERS) {
    const value = res.getHeader(name);
    if (value === undefined || value === null) continue;
    try {
      const decoded = JSON.parse(Buffer.from(String(value), "base64").toString("utf8")) as Record<string, unknown>;
      if (typeof decoded.transaction === "string" && decoded.transaction !== "") return decoded.transaction;
    } catch {
      return null;
    }
  }
  return null;
}

function nonceOf(raw: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    const payload = (decoded.payload ?? {}) as Record<string, unknown>;
    const authorization = (payload.authorization ?? {}) as Record<string, unknown>;
    return typeof authorization.nonce === "string" && authorization.nonce !== "" ? authorization.nonce : null;
  } catch {
    return null;
  }
}

/**
 * The gateway used until a real channel adapter is wired.
 *
 * It REFUSES rather than pretending, and the refusal is retryable so the delivery stays claimable once
 * an adapter arrives. A gateway that returned `ok: true` without sending would mark a delivery SENT and
 * leave a person waiting for a message that was never written — which is the exact failure the whole
 * approval-path readiness flag exists to prevent, arriving one layer lower.
 *
 * With `APPROVAL_PATH_READY` false nothing reaches this: no approval request is created, so no delivery
 * is ever projected. It is the seam the Discord adapter fills, not a fallback that runs in production.
 */
export const unconfiguredChannelGateway: ChannelGateway = {
  async send() {
    return {
      ok: false,
      retryable: true,
      failureCode: "CHANNEL_GATEWAY_NOT_WIRED",
    };
  },
};

export interface ApprovalWorkers {
  readonly health: () => { readonly reconciler: WorkerHealth; readonly delivery: WorkerHealth };
  readonly stop: () => void;
  /** One pass of each, awaited. Exposed so a test drives the loops without waiting on timers. */
  readonly runOnce: () => Promise<void>;
}

/**
 * The loops.
 *
 * Two of them, deliberately separate. Reconciliation asks an authority about money and must be able to
 * run at its own pace; delivery talks to Discord and should be quick. Sharing one interval would tie
 * how fast a human is told to how often a facilitator is polled.
 *
 * Both are safe on every replica at once: the reconciler claims rows with FOR UPDATE SKIP LOCKED, and
 * the delivery worker claims and marks SENDING in a committed transaction before the network call.
 *
 * Neither may initiate or retry a payment, and neither may touch payment, policy, decision, budget or
 * reservation state. The reconciler's only write path is `finalizeSettlement`; the delivery worker's
 * only writes are to the outbox and delivery tables.
 */
export function startApprovalWorkers(deps: ApprovalLifecycleDeps): ApprovalWorkers {
  const log = deps.log ?? ((line: string) => console.log(line));
  const reconcileHealth = new Health();
  const deliveryHealth = new Health();
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const reconcilePass = async (): Promise<void> => {
    const report = await reconcileOnce(deps.pool, deps.oracle, { limit: 20 });
    reconcileHealth.ok();
    if (report.claimed > 0 || report.errors.length > 0) {
      log(`[approval-reconciler] ${JSON.stringify(report)}`);
    }
  };

  const deliveryPass = async (): Promise<void> => {
    const created = await projectDeliveries(deps.pool, { limit: 20 });
    const report = await deliverOnce(deps.pool, deps.gateway, { limit: 20 });
    deliveryHealth.ok();
    if (created > 0 || report.claimed > 0) {
      log(`[approval-delivery] ${JSON.stringify({ projected: created, ...report })}`);
    }
  };

  /**
   * `unref` so a worker timer never keeps the process alive on shutdown. A container that will not exit
   * because a polling loop is pending is a deploy that hangs, and the loops hold no state worth
   * draining — every pass reads committed data and every claim is released by the database.
   */
  const loop = (name: string, fn: () => Promise<void>, health: Health, intervalMs: number): void => {
    health.running = true;
    const tick = (): void => {
      if (stopped) return;
      fn().catch((err: unknown) => {
        health.fail(err);
        log(`[approval-${name}] pass failed: ${(err as Error).message}`);
      });
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    timers.push(timer);
  };

  loop("reconciler", reconcilePass, reconcileHealth, deps.reconcileIntervalMs ?? 30_000);
  loop("delivery", deliveryPass, deliveryHealth, deps.deliverIntervalMs ?? 5_000);

  return {
    health: () => ({ reconciler: reconcileHealth.report("reconciler"), delivery: deliveryHealth.report("delivery") }),
    stop: () => {
      stopped = true;
      reconcileHealth.running = false;
      deliveryHealth.running = false;
      for (const t of timers) clearInterval(t);
    },
    runOnce: async () => {
      await reconcilePass().catch((err: unknown) => reconcileHealth.fail(err));
      await deliveryPass().catch((err: unknown) => deliveryHealth.fail(err));
    },
  };
}
