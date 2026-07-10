import { Queue, Worker, type Processor } from "bullmq";
import { createRedis } from "@untch/receipt-writer";
import type { Redis } from "ioredis";
import type { TimeoutScheduler } from "./service";

/**
 * BullMQ transport for the escalation TIMEOUT (§7.2 timeout T → EXPIRED → default DENY). It reuses the
 * SAME Redis/BullMQ that the receipt writer already provisions — `createRedis` is re-exported from
 * @untch/receipt-writer verbatim, so there is no second Redis and no second connection policy. This is
 * a distinct QUEUE on that shared instance (timeouts are DELAYED jobs — a different shape from the
 * receipt writer's fire-and-forget ticks), not a second Redis: "reuse what's already provisioned."
 *
 * Redis is a convenience, not the authority: even if a timeout job is lost, the service's derived-expiry
 * (an open escalation past `code_expires_at` reads as DENIED) and the `sweepExpired` backstop guarantee
 * the fail-closed default still fires. The job just makes it prompt.
 */

export { createRedis };

// BullMQ forbids ':' in queue names — use a hyphenated name.
export const TIMEOUT_QUEUE = "untch-escalation-timeouts" as const;

export interface TimeoutJob {
  readonly escalationId: string;
}

export function createTimeoutQueue(connection: Redis): Queue<TimeoutJob> {
  return new Queue<TimeoutJob>(TIMEOUT_QUEUE, { connection });
}

export function createTimeoutWorker(
  connection: Redis,
  processor: Processor<TimeoutJob>,
): Worker<TimeoutJob> {
  return new Worker<TimeoutJob>(TIMEOUT_QUEUE, processor, { connection, concurrency: 4 });
}

/**
 * A `TimeoutScheduler` backed by a BullMQ delayed job. `jobId` is keyed to the escalation so scheduling
 * the same escalation twice de-duplicates rather than double-firing. The delay is computed from the
 * fire-at instant; a past instant fires immediately (delay 0).
 */
export function makeTimeoutScheduler(
  queue: Queue<TimeoutJob>,
  clock: () => number = Date.now,
): TimeoutScheduler {
  return async (escalationId, fireAtMs) => {
    const delay = Math.max(0, fireAtMs - clock());
    await queue.add(
      "timeout",
      { escalationId },
      { delay, jobId: `to:${escalationId}`, removeOnComplete: true, removeOnFail: 1000 },
    );
  };
}
