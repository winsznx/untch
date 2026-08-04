import { randomBytes } from "node:crypto";
import type { Pool } from "./db";
import { actionTokenFamily } from "./approval-action-token";

/**
 * The worker that turns a committed outbox event into messages.
 *
 * WHY IT IS A WORKER AND NOT A CALL INSIDE THE TRANSACTION
 *
 * A channel gateway is a network call to somebody else's server. Inside the decision or finalizer
 * transaction it would hold database locks for the length of a Telegram round trip, and worse, a
 * transaction that later rolled back would already have sent a message about a payment that never
 * happened. A person cannot un-read that.
 *
 * So the transaction writes an outbox row and nothing else. This runs afterwards, reads only committed
 * state, and sends. If it crashes mid-send the row is still claimable, which is why sending is
 * idempotent per (request, binding) rather than per attempt.
 *
 * WHAT IT MAY NEVER DO
 *
 * Touch payment, policy or reservation state. It resolves who to tell and records whether telling
 * worked. Anything else belongs to a path that took the locks properly.
 */

export type DeliveryStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "ACTED"
  | "INVALIDATED"
  | "EXPIRED";

export interface DeliveryTarget {
  readonly approvalDeliveryId: string;
  readonly approvalRequestId: string;
  readonly accountId: string;
  readonly channelBindingId: string;
  readonly channel: string;
  readonly channelUserId: string;
  readonly channelChatId: string | null;
  readonly canDecide: boolean;
  readonly actionTokenFamily: string;
  readonly attempts: number;
}

export interface SendOutcome {
  readonly ok: boolean;
  readonly externalDeliveryId?: string | null;
  readonly retryable?: boolean;
  readonly failureCode?: string;
}

/** The gateway seam. A test passes a recorder; production passes a real adapter. */
export interface ChannelGateway {
  send(target: DeliveryTarget): Promise<SendOutcome>;
}

export interface DeliveryReport {
  readonly claimed: number;
  readonly sent: number;
  readonly retryable: number;
  readonly terminal: number;
  readonly skipped: number;
}

export function newApprovalDeliveryId(): string {
  return `apdl_${randomBytes(16).toString("hex")}`;
}

const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000] as const;

/**
 * Turn ready events into delivery rows.
 *
 * Runs in its own transaction per event. The rows it creates are QUEUED, so a crash between this and
 * the send leaves work that is still obviously unfinished rather than a message half sent.
 *
 * One row per (request, binding), enforced by a unique index, so running this twice on the same event
 * produces the same rows rather than a second set.
 */
export async function projectDeliveries(pool: Pool, opts: { readonly limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 20;
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query("BEGIN");
    const { rows: events } = await client.query<{ event_id: string; approval_request_id: string }>(
      `SELECT event_id, approval_request_id FROM untch_approval_outbox
        WHERE dispatched = FALSE AND name = 'approval.request.ready.v1'
        ORDER BY occurred_at ASC LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    for (const ev of events) {
      const { rows: reqRows } = await client.query<{ account_id: string; state: string }>(
        `SELECT account_id, state FROM untch_approval_requests WHERE approval_request_id = $1`,
        [ev.approval_request_id],
      );
      const request = reqRows[0];
      /**
       * A request that is no longer PENDING gets no actionable delivery. The event was true when it
       * was written and the world moved on, which is an ordinary race rather than an error.
       */
      if (!request || request.state !== "PENDING") {
        await client.query(`UPDATE untch_approval_outbox SET dispatched = TRUE WHERE event_id = $1`, [ev.event_id]);
        continue;
      }

      /** Only ACTIVE bindings that may actually receive an approval. A revoked one is skipped. */
      const { rows: bindings } = await client.query<{ binding_id: string; channel: string }>(
        `SELECT binding_id, channel FROM untch_channel_bindings
          WHERE account_id = $1 AND status = 'ACTIVE' AND 'policy-approval' = ANY(scopes)`,
        [request.account_id],
      );

      const family = actionTokenFamily(ev.approval_request_id, Date.parse(new Date().toISOString()));
      for (const b of bindings) {
        const { rowCount } = await client.query(
          `INSERT INTO untch_approval_deliveries
             (delivery_id, approval_request_id, account_id, channel, channel_binding_id,
              outcome, status, action_token_family, queued_at, next_attempt_at)
           VALUES ($1,$2,$3,$4,$5,'SKIPPED','QUEUED',$6, now(), now())
           ON CONFLICT (approval_request_id, channel_binding_id) WHERE channel_binding_id IS NOT NULL DO NOTHING`,
          [newApprovalDeliveryId(), ev.approval_request_id, request.account_id, b.channel, b.binding_id, family],
        );
        created += rowCount ?? 0;
      }
      await client.query(`UPDATE untch_approval_outbox SET dispatched = TRUE WHERE event_id = $1`, [ev.event_id]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return created;
}

/**
 * Send what is queued.
 *
 * Each delivery is claimed with FOR UPDATE SKIP LOCKED and marked SENDING in its own committed
 * transaction BEFORE the network call, so a second worker steps over it rather than sending the same
 * message. The gateway call happens outside any transaction, because holding one across a network
 * round trip is how a slow channel becomes a database problem.
 */
export async function deliverOnce(
  pool: Pool,
  gateway: ChannelGateway,
  opts: { readonly limit?: number; readonly nowMs?: number } = {},
): Promise<DeliveryReport> {
  const limit = opts.limit ?? 20;
  const now = opts.nowMs ?? Date.now();
  let sent = 0;
  let retryable = 0;
  let terminal = 0;
  let skipped = 0;

  const claim = await pool.connect();
  let targets: DeliveryTarget[] = [];
  try {
    await claim.query("BEGIN");
    const { rows } = await claim.query<Record<string, unknown>>(
      `SELECT d.delivery_id, d.approval_request_id, d.account_id, d.channel_binding_id, d.channel,
              d.action_token_family, d.attempts,
              b.channel_user_id, b.channel_chat_id, b.can_decide, b.status AS binding_status,
              r.state AS request_state
         FROM untch_approval_deliveries d
         JOIN untch_channel_bindings b ON b.binding_id = d.channel_binding_id
         JOIN untch_approval_requests r ON r.approval_request_id = d.approval_request_id
        WHERE d.status IN ('QUEUED', 'FAILED_RETRYABLE')
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= $2::timestamptz)
        ORDER BY d.queued_at ASC
        LIMIT $1
          FOR UPDATE OF d SKIP LOCKED`,
      [limit, new Date(now).toISOString()],
    );

    for (const r of rows) {
      /**
       * Re-checked at claim time, not only at projection time. A binding revoked or a request resolved
       * between queueing and sending must not produce a message, and this is the last moment that can
       * be noticed.
       */
      if (r.binding_status !== "ACTIVE" || r.request_state !== "PENDING") {
        await claim.query(
          `UPDATE untch_approval_deliveries SET status = 'INVALIDATED', invalidated_at = now() WHERE delivery_id = $1`,
          [r.delivery_id],
        );
        skipped += 1;
        continue;
      }
      await claim.query(
        `UPDATE untch_approval_deliveries SET status = 'SENDING', attempts = attempts + 1 WHERE delivery_id = $1`,
        [r.delivery_id],
      );
      targets.push({
        approvalDeliveryId: String(r.delivery_id),
        approvalRequestId: String(r.approval_request_id),
        accountId: String(r.account_id),
        channelBindingId: String(r.channel_binding_id),
        channel: String(r.channel),
        channelUserId: String(r.channel_user_id),
        channelChatId: r.channel_chat_id === null ? null : String(r.channel_chat_id),
        canDecide: r.can_decide === true,
        actionTokenFamily: String(r.action_token_family ?? ""),
        attempts: Number(r.attempts ?? 0),
      });
    }
    await claim.query("COMMIT");
  } catch (err) {
    await claim.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    claim.release();
  }

  for (const target of targets) {
    let outcome: SendOutcome;
    try {
      outcome = await gateway.send(target);
    } catch (err) {
      outcome = { ok: false, retryable: true, failureCode: `GATEWAY_THREW: ${(err as Error).message.slice(0, 120)}` };
    }

    if (outcome.ok) {
      await pool.query(
        `UPDATE untch_approval_deliveries
            SET status = 'SENT', outcome = 'SENT', sent_at = now(), external_delivery_id = $2, failure_code = NULL
          WHERE delivery_id = $1`,
        [target.approvalDeliveryId, outcome.externalDeliveryId ?? null],
      );
      sent += 1;
      continue;
    }

    const attempts = target.attempts + 1;
    const canRetry = outcome.retryable !== false && attempts < BACKOFF_MS.length;
    if (canRetry) {
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 0;
      await pool.query(
        `UPDATE untch_approval_deliveries
            SET status = 'FAILED_RETRYABLE', outcome = 'FAILED', failure_code = $2,
                next_attempt_at = $3::timestamptz
          WHERE delivery_id = $1`,
        [target.approvalDeliveryId, outcome.failureCode ?? "UNKNOWN", new Date(now + delay).toISOString()],
      );
      retryable += 1;
    } else {
      await pool.query(
        `UPDATE untch_approval_deliveries
            SET status = 'FAILED_TERMINAL', outcome = 'FAILED', failure_code = $2, next_attempt_at = NULL
          WHERE delivery_id = $1`,
        [target.approvalDeliveryId, outcome.failureCode ?? "UNKNOWN"],
      );
      terminal += 1;
    }
  }

  return { claimed: targets.length + skipped, sent, retryable, terminal, skipped };
}
