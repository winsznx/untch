/**
 * Approval delivery over Cloudflare Queues, with Postgres still holding the truth.
 *
 * WHAT THE QUEUE IS AND IS NOT
 *
 * It is a WAKE-UP, not a work item. The message carries an opaque identifier and nothing else: no
 * channel, no recipient, no amount, no token. Everything that decides what happens is re-read from the
 * database by the consumer, so a message that is delayed, duplicated or replayed a day later cannot
 * act on a world that has moved. A queue payload carrying the decision would be a second source of
 * truth, and the two would eventually disagree about something financial.
 *
 * This is why the existing poll-based sweep is KEPT rather than replaced. Queues make delivery fast;
 * the sweep makes it certain. If publication fails after the transaction commits — and it can, because
 * commit and publish cannot share a transaction — the row is still in the outbox and the sweep finds
 * it. Deleting the sweep would turn every publish failure into a message a person never receives.
 *
 * THE ORDER, WHICH IS THE PART THAT MATTERS
 *
 *   1. the business transaction commits the delivery row
 *   2. ONLY THEN is an identifier published
 *   3. the consumer re-reads the canonical row
 *   4. it claims the row idempotently, or does nothing
 *   5. it performs the side effect
 *   6. it records success, retryable failure, or terminal failure
 *   7. a scheduled sweep finds anything committed but never published, or claimed and abandoned
 *
 * Publishing before commit is the bug this ordering exists to prevent: the consumer can win the race,
 * read a row that does not exist yet, and conclude there is nothing to do — losing the delivery
 * permanently while every component reports success.
 */

import type { Pool } from "@untch/consumer-core";

/** The entire message. An identifier and a version, so a consumer can reject a shape it cannot read. */
export interface DeliveryMessage {
  readonly v: 1;
  readonly deliveryId: string;
}

export function isDeliveryMessage(value: unknown): value is DeliveryMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DeliveryMessage).v === 1 &&
    typeof (value as DeliveryMessage).deliveryId === "string" &&
    (value as DeliveryMessage).deliveryId.length > 0
  );
}

/** The Cloudflare Queue producer binding, narrowed to what this uses. */
export interface QueueProducer {
  send(body: unknown, options?: { contentType?: string }): Promise<void>;
  sendBatch(messages: { body: unknown }[]): Promise<void>;
}

/** One message as the consumer sees it. */
export interface QueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch {
  readonly messages: readonly QueueMessage[];
}

/**
 * Publish AFTER the caller's transaction has committed.
 *
 * Takes ids rather than a transaction handle so it cannot accidentally be called inside one. A publish
 * that happens before commit is the ordering bug described above, and the shape of this function is
 * what makes that hard to write by mistake.
 *
 * A publish failure is swallowed deliberately. The row is committed and the sweep will find it, so
 * turning a transient Queue outage into a thrown error would fail a request whose durable work already
 * succeeded. It is logged, and the sweep's own health is what tells an operator something is wrong.
 */
export async function publishCommittedDeliveries(
  queue: QueueProducer,
  deliveryIds: readonly string[],
  log: (line: string) => void = () => {},
): Promise<{ readonly published: number; readonly failed: number }> {
  if (deliveryIds.length === 0) return { published: 0, failed: 0 };
  try {
    await queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { v: 1, deliveryId } satisfies DeliveryMessage })));
    return { published: deliveryIds.length, failed: 0 };
  } catch (err) {
    log(`[queue] publish failed for ${deliveryIds.length} deliveries, the sweep will recover them: ${(err as Error).message}`);
    return { published: 0, failed: deliveryIds.length };
  }
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly target: DeliveryTargetRow }
  | { readonly kind: "not-found" }
  | { readonly kind: "already-terminal"; readonly status: string }
  | { readonly kind: "not-due" }
  | { readonly kind: "held-by-another" };

export interface DeliveryTargetRow {
  readonly deliveryId: string;
  readonly approvalRequestId: string;
  readonly accountId: string;
  readonly channelBindingId: string;
  readonly channel: string;
  readonly attempts: number;
}

/**
 * Claim exactly one delivery, by id, or explain why not.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes at-least-once safe: two consumers handed the same message
 * both run this, one wins the lock and the other is told the row is held. Neither sends twice.
 *
 * Due-ness is decided by the DATABASE clock, for the same reason the sweep does: `next_attempt_at` is
 * written by `now()` in Postgres, and comparing it to a Worker's `Date.now()` makes the answer depend
 * on the skew between two machines in different regions.
 */
export async function claimDeliveryById(pool: Pool, deliveryId: string): Promise<ClaimOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT d.delivery_id, d.approval_request_id, d.account_id, d.channel_binding_id, d.channel,
              d.attempts, d.status,
              (d.next_attempt_at IS NULL OR d.next_attempt_at <= now()) AS due
         FROM untch_approval_deliveries d
        WHERE d.delivery_id = $1
          FOR UPDATE OF d SKIP LOCKED`,
      [deliveryId],
    );

    const row = rows[0];
    if (!row) {
      /**
       * Either the row never existed, or another consumer holds its lock. Distinguished with a
       * lock-free read, because "someone else is sending it" and "this id is nonsense" call for
       * different answers: the first is an ack, the second is a dead letter.
       */
      const { rows: exists } = await client.query<{ status: string }>(
        `SELECT status FROM untch_approval_deliveries WHERE delivery_id = $1`,
        [deliveryId],
      );
      await client.query("ROLLBACK");
      return exists[0] ? { kind: "held-by-another" } : { kind: "not-found" };
    }

    const status = String(row.status);
    if (status !== "QUEUED" && status !== "FAILED_RETRYABLE") {
      await client.query("ROLLBACK");
      return { kind: "already-terminal", status };
    }
    if (row.due !== true) {
      await client.query("ROLLBACK");
      return { kind: "not-due" };
    }

    await client.query("COMMIT");
    return {
      kind: "claimed",
      target: {
        deliveryId: String(row.delivery_id),
        approvalRequestId: String(row.approval_request_id),
        accountId: String(row.account_id),
        channelBindingId: String(row.channel_binding_id),
        channel: String(row.channel),
        attempts: Number(row.attempts ?? 0),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** How many times a message is retried before it is dead-lettered rather than retried forever. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface ConsumeDeps {
  readonly pool: Pool;
  /**
   * How a row is claimed. Injectable because the consumer's decision table — send, ack, retry or
   * dead-letter for each outcome — is what decides whether a redelivered message reaches a person
   * twice, and that deserves to be testable without a database standing in the way.
   */
  readonly claim?: (pool: Pool, deliveryId: string) => Promise<ClaimOutcome>;
  /** Sends one delivery. Reuses the same gateway the sweep uses, so there is one send implementation. */
  readonly deliverOne: (target: DeliveryTargetRow) => Promise<{ readonly outcome: "sent" | "retryable" | "terminal" }>;
  readonly log?: (line: string) => void;
  readonly maxAttempts?: number;
}

export interface ConsumeReport {
  readonly sent: number;
  readonly retried: number;
  readonly terminal: number;
  readonly acked: number;
  readonly deadLettered: number;
}

/**
 * Handle one Queue batch.
 *
 * Every message is acked or retried explicitly. An unhandled message is redelivered by Cloudflare,
 * which is correct but silent, so the decision is always made here on purpose.
 */
export async function consumeDeliveryBatch(batch: QueueBatch, deps: ConsumeDeps): Promise<ConsumeReport> {
  const log = deps.log ?? (() => {});
  const maxAttempts = deps.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  let sent = 0;
  let retried = 0;
  let terminal = 0;
  let acked = 0;
  let deadLettered = 0;

  for (const message of batch.messages) {
    if (!isDeliveryMessage(message.body)) {
      /**
       * Acked, not retried. A shape this consumer cannot read will never become readable, and retrying
       * it until the dead-letter limit only delays the same outcome while occupying the queue.
       */
      log(`[queue] unreadable message ${message.id}, acking to the dead letter`);
      message.ack();
      deadLettered += 1;
      continue;
    }

    const { deliveryId } = message.body;

    if (message.attempts > maxAttempts) {
      log(`[queue] delivery ${deliveryId} exceeded ${maxAttempts} attempts, dead-lettering`);
      message.ack();
      deadLettered += 1;
      continue;
    }

    const claimFn = deps.claim ?? claimDeliveryById;
    let claim: ClaimOutcome;
    try {
      claim = await claimFn(deps.pool, deliveryId);
    } catch (err) {
      // A database error is transient by assumption; the row is still committed and still claimable.
      log(`[queue] claim failed for ${deliveryId}, retrying: ${(err as Error).message}`);
      message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      retried += 1;
      continue;
    }

    switch (claim.kind) {
      case "not-found":
        // Nothing to deliver and nothing will appear. Acked so it does not circulate.
        log(`[queue] delivery ${deliveryId} does not exist, acking`);
        message.ack();
        acked += 1;
        break;

      case "already-terminal":
        /**
         * THE DUPLICATE-SUPPRESSION POINT.
         *
         * At-least-once means this message may be a redelivery of one already handled. The row says it
         * is finished, so nothing is sent — which is what stops a person being messaged twice.
         */
        log(`[queue] delivery ${deliveryId} is already ${claim.status}, acking without sending`);
        message.ack();
        acked += 1;
        break;

      case "held-by-another":
        // Another consumer holds the lock. Acked rather than retried: whoever holds it will finish,
        // and the sweep covers the case where they die mid-flight.
        message.ack();
        acked += 1;
        break;

      case "not-due":
        message.retry({ delaySeconds: 30 });
        retried += 1;
        break;

      case "claimed": {
        try {
          const result = await deps.deliverOne(claim.target);
          if (result.outcome === "sent") sent += 1;
          else if (result.outcome === "terminal") terminal += 1;
          else retried += 1;
          message.ack();
          acked += 1;
        } catch (err) {
          log(`[queue] send threw for ${deliveryId}, retrying: ${(err as Error).message}`);
          message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
          retried += 1;
        }
        break;
      }
    }
  }

  return { sent, retried, terminal, acked, deadLettered };
}

/**
 * Find deliveries that were committed but never reached a consumer.
 *
 * The safety net that makes the queue an optimisation rather than a dependency. It covers a publish
 * that failed after commit, a consumer that died between claiming and recording, and a queue outage
 * long enough to exhaust retries.
 */
export async function findUnpublishedDeliveries(
  pool: Pool,
  opts: { readonly olderThanSeconds?: number; readonly limit?: number } = {},
): Promise<readonly string[]> {
  const olderThan = opts.olderThanSeconds ?? 60;
  const limit = opts.limit ?? 100;
  const { rows } = await pool.query<{ delivery_id: string }>(
    `SELECT delivery_id
       FROM untch_approval_deliveries
      WHERE status IN ('QUEUED', 'FAILED_RETRYABLE')
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND queued_at <= now() - make_interval(secs => $1)
      ORDER BY queued_at ASC
      LIMIT $2`,
    [olderThan, limit],
  );
  return rows.map((r) => r.delivery_id);
}
