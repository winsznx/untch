/**
 * Workflow events and the transactional outbox contract.
 *
 * The rule the outbox exists to enforce: a state change and the event announcing it are written in
 * ONE Postgres transaction. There is no code path where an intent advances without an event, and
 * none where an event describes a state the database never reached. Redis is a nudge; a periodic
 * sweep of undispatched rows is the backstop; Postgres is the record. This mirrors the posture
 * @untch/receipt-writer already takes ("durability does NOT depend on Redis").
 *
 * Sequence numbers are per-intent and monotonic, assigned by the same transaction that writes the
 * state. That is what makes SSE `Last-Event-ID` resume exact rather than best-effort.
 */

import type { ConsumerIntentState } from "./state";

export const CONSUMER_EVENT_NAMES = [
  "consumer.intent.created",
  "consumer.discovery.completed",
  "consumer.quote.created",
  "consumer.policy.approved",
  "consumer.policy.blocked",
  "consumer.approval.required",
  "consumer.approval.completed",
  "consumer.funding.requested",
  "consumer.funding.confirmed",
  "consumer.execution.started",
  "consumer.provider.paid",
  "consumer.provider.acknowledged",
  "consumer.delivery.verified",
  "consumer.completed",
  "consumer.failed",
  "consumer.refund.pending",
  "consumer.refunded",
  "consumer.manual_review.required",
] as const;

export type ConsumerEventName = (typeof CONSUMER_EVENT_NAMES)[number];

const EVENT_SET: ReadonlySet<string> = new Set(CONSUMER_EVENT_NAMES);

export function isConsumerEventName(v: unknown): v is ConsumerEventName {
  return typeof v === "string" && EVENT_SET.has(v);
}

export interface ConsumerEvent {
  readonly eventId: string;
  readonly intentId: string;
  readonly tenantId: string;
  /** Per-intent, monotonic, gapless. The SSE `id:` and the Last-Event-ID resume cursor. */
  readonly seq: number;
  readonly name: ConsumerEventName;
  readonly state: ConsumerIntentState;
  readonly correlationId: string;
  /** Redaction-safe payload. Never contains addresses in full, payment payloads or personal data. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/** An outbox row before dispatch. `attempts`/`lastError` make a stuck dispatcher visible. */
export interface OutboxRecord extends ConsumerEvent {
  readonly dispatched: boolean;
  readonly attempts: number;
  readonly lastError: string | null;
}

/** The terminal-ness of an event, used to decide when an SSE stream may close. */
export const TERMINAL_EVENTS: ReadonlySet<ConsumerEventName> = new Set<ConsumerEventName>([
  "consumer.completed",
  "consumer.failed",
  "consumer.refunded",
  "consumer.policy.blocked",
]);

/**
 * The canonical state → event mapping. Kept as data so the orchestrator cannot emit an event that
 * contradicts the transition it just made, and so the test suite can assert the map is total over
 * every state that is worth announcing.
 */
export const EVENT_FOR_STATE: Readonly<Partial<Record<ConsumerIntentState, ConsumerEventName>>> =
  Object.freeze({
    CREATED: "consumer.intent.created",
    DISCOVERING: "consumer.discovery.completed",
    QUOTED: "consumer.quote.created",
    BLOCKED: "consumer.policy.blocked",
    AWAITING_APPROVAL: "consumer.approval.required",
    APPROVED: "consumer.approval.completed",
    AWAITING_FUNDING: "consumer.funding.requested",
    FUNDED: "consumer.funding.confirmed",
    EXECUTION_QUEUED: "consumer.execution.started",
    PROVIDER_PAID: "consumer.provider.paid",
    PROVIDER_ACKNOWLEDGED: "consumer.provider.acknowledged",
    DELIVERY_VERIFIED: "consumer.delivery.verified",
    COMPLETED: "consumer.completed",
    FAILED_BEFORE_PAYMENT: "consumer.failed",
    FAILED_AFTER_PAYMENT: "consumer.failed",
    REFUND_PENDING: "consumer.refund.pending",
    REFUNDED: "consumer.refunded",
    MANUAL_REVIEW: "consumer.manual_review.required",
    EXPIRED: "consumer.failed",
    CANCELLED: "consumer.failed",
  });

export function eventForState(state: ConsumerIntentState): ConsumerEventName | null {
  return EVENT_FOR_STATE[state] ?? null;
}

/** SSE wire framing. Written here so the transport and the resume semantics stay together. */
export function toSseFrame(evt: ConsumerEvent): string {
  const payload = JSON.stringify({
    intentId: evt.intentId,
    seq: evt.seq,
    name: evt.name,
    state: evt.state,
    correlationId: evt.correlationId,
    data: evt.data,
    occurredAt: evt.occurredAt,
  });
  return `id: ${evt.seq}\nevent: ${evt.name}\ndata: ${payload}\n\n`;
}

/** A comment frame. Keeps proxies from closing an idle stream without looking like an event. */
export function sseHeartbeat(nowIso: string): string {
  return `: heartbeat ${nowIso}\n\n`;
}

/** Parse a `Last-Event-ID` header into a resume cursor. Anything unparseable resumes from zero. */
export function parseLastEventId(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound webhooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Webhook signature: HMAC-SHA256 over `${timestamp}.${body}` with the tenant's secret, in the
 * `Untch-Signature: t=<unix>,v1=<hex>` form. The timestamp is inside the signed material, so a
 * captured delivery cannot be replayed later with a fresh timestamp.
 */
export function webhookSigningPayload(timestampSec: number, body: string): string {
  return `${timestampSec}.${body}`;
}

export function webhookSignatureHeader(timestampSec: number, hexMac: string): string {
  return `t=${timestampSec},v1=${hexMac}`;
}

export interface ParsedWebhookSignature {
  readonly timestampSec: number;
  readonly mac: string;
}

export function parseWebhookSignatureHeader(raw: unknown): ParsedWebhookSignature | null {
  if (typeof raw !== "string") return null;
  let timestampSec: number | null = null;
  let mac: string | null = null;
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === undefined || v === undefined) continue;
    if (k.trim() === "t") {
      const n = Number.parseInt(v.trim(), 10);
      if (Number.isSafeInteger(n)) timestampSec = n;
    } else if (k.trim() === "v1") {
      mac = v.trim();
    }
  }
  if (timestampSec === null || mac === null || !/^[0-9a-f]{64}$/.test(mac)) return null;
  return { timestampSec, mac };
}

/** Retry schedule for webhook delivery: capped exponential backoff, 8 attempts, ~4h total. */
export const WEBHOOK_BACKOFF_MS: readonly number[] = Object.freeze([
  1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000,
]);

export function webhookRetryDelayMs(attempt: number): number | null {
  return WEBHOOK_BACKOFF_MS[attempt] ?? null;
}
