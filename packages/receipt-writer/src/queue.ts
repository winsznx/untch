import { Queue, Worker, type Processor } from "bullmq";
import IORedis, { type Redis } from "ioredis";

/**
 * BullMQ transport for the batching signal (§22: Redis + BullMQ, not a hand-rolled queue). The queue
 * carries lightweight "tick" jobs — one per enqueued receipt — that nudge the worker's Batcher. It is
 * only a SIGNAL: the receipt itself is already durable in Postgres, so a lost tick never loses a
 * receipt (the worker's safety sweep re-scans QUEUED rows). Keeping the payload to just the receiptId
 * means Redis holds no authoritative state.
 */

// BullMQ forbids ':' in queue names (it namespaces Redis keys with ':'), so use a hyphenated name.
export const TICK_QUEUE = "untch-receipt-ticks" as const;

export interface TickJob {
  readonly receiptId: string;
}

/** ioredis connection tuned for BullMQ (`maxRetriesPerRequest: null` is required by BullMQ). */
export function createRedis(redisUrl: string): Redis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createTickQueue(connection: Redis): Queue<TickJob> {
  return new Queue<TickJob>(TICK_QUEUE, { connection });
}

export function createTickWorker(
  connection: Redis,
  processor: Processor<TickJob>,
): Worker<TickJob> {
  return new Worker<TickJob>(TICK_QUEUE, processor, {
    connection,
    concurrency: 1,
  });
}
