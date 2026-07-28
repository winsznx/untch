/**
 * The outbox dispatcher and the SSE hub.
 *
 * The contract the whole event surface rests on: an event exists in Postgres the instant the state
 * change that produced it commits. Delivery is a separate, best-effort concern layered on top. That
 * ordering is why a subscriber can disconnect, reconnect with `Last-Event-ID`, and be certain it
 * missed nothing — the record was never in a socket buffer to begin with.
 *
 * Live subscribers are a fan-out over the SAME rows, not a second channel: `SseHub.publish` is fed by
 * the dispatcher, and a resuming client replays from `eventsSince` before attaching. So the two paths
 * cannot diverge, and a client that resumes across a restart sees exactly the same sequence a client
 * that stayed connected saw.
 */

import {
  parseLastEventId,
  sseHeartbeat,
  toSseFrame,
  webhookRetryDelayMs,
  webhookSignatureHeader,
  webhookSigningPayload,
  type ConsumerEvent,
  type ConsumerStore,
} from "@untch/consumer-core";
import { createHmac } from "node:crypto";

export interface SseSubscriber {
  readonly intentId: string;
  write(chunk: string): void;
  close(): void;
}

/**
 * The in-process fan-out. Deliberately per-instance: it is a latency optimisation, and a client on
 * another instance still gets every event by polling `eventsSince`. Making it cross-instance would
 * mean a message bus whose failure modes are worse than the polling it replaces.
 */
export class SseHub {
  private readonly byIntent = new Map<string, Set<SseSubscriber>>();

  subscribe(sub: SseSubscriber): () => void {
    let set = this.byIntent.get(sub.intentId);
    if (!set) {
      set = new Set();
      this.byIntent.set(sub.intentId, set);
    }
    set.add(sub);
    return () => {
      set?.delete(sub);
      if (set && set.size === 0) this.byIntent.delete(sub.intentId);
    };
  }

  subscriberCount(intentId: string): number {
    return this.byIntent.get(intentId)?.size ?? 0;
  }

  publish(event: ConsumerEvent): void {
    const set = this.byIntent.get(event.intentId);
    if (!set) return;
    const frame = toSseFrame(event);
    for (const sub of set) {
      try {
        sub.write(frame);
      } catch {
        // A dead socket is not an error worth propagating; the row is durable and the client will
        // resume from it. Drop the subscriber and move on.
        set.delete(sub);
      }
    }
  }

  heartbeat(nowIso: string): void {
    const frame = sseHeartbeat(nowIso);
    for (const set of this.byIntent.values()) {
      for (const sub of set) {
        try {
          sub.write(frame);
        } catch {
          set.delete(sub);
        }
      }
    }
  }

  closeAll(): void {
    for (const set of this.byIntent.values()) {
      for (const sub of set) {
        try {
          sub.close();
        } catch {
          // already gone
        }
      }
    }
    this.byIntent.clear();
  }
}

export interface WebhookTarget {
  readonly endpointId: string;
  readonly tenantId: string;
  readonly url: string;
  readonly secret: string;
}

export interface DispatcherDeps {
  readonly store: ConsumerStore;
  readonly hub: SseHub;
  /** Resolve a tenant's webhook targets. Absent ⇒ SSE only, which is the default posture. */
  readonly webhooksFor?: (tenantId: string) => Promise<readonly WebhookTarget[]>;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly log?: (line: string, data?: unknown) => void;
}

export class OutboxDispatcher {
  private readonly d: DispatcherDeps;
  private readonly clock: () => number;
  private readonly log: (line: string, data?: unknown) => void;

  constructor(deps: DispatcherDeps) {
    this.d = deps;
    this.clock = deps.clock ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Drain a batch of undispatched events.
   *
   * A failure marks the row `attempts += 1` and leaves it undispatched, so the next sweep retries it.
   * Nothing is dropped, and nothing blocks the state machine — the dispatcher is downstream of every
   * transition by construction.
   */
  async drain(limit = 100): Promise<number> {
    const pending = await this.d.store.pendingOutbox(limit);
    let delivered = 0;

    for (const record of pending) {
      const event: ConsumerEvent = {
        eventId: record.eventId,
        intentId: record.intentId,
        tenantId: record.tenantId,
        seq: record.seq,
        name: record.name,
        state: record.state,
        correlationId: record.correlationId,
        data: record.data,
        occurredAt: record.occurredAt,
      };
      try {
        this.d.hub.publish(event);
        await this.deliverWebhooks(event);
        await this.d.store.markDispatched(record.eventId);
        delivered += 1;
      } catch (err) {
        await this.d.store.markDispatchFailed(record.eventId, (err as Error).message);
        this.log("[consumer] event dispatch failed", {
          eventId: record.eventId,
          attempts: record.attempts + 1,
        });
      }
    }
    return delivered;
  }

  private async deliverWebhooks(event: ConsumerEvent): Promise<void> {
    if (!this.d.webhooksFor) return;
    const targets = await this.d.webhooksFor(event.tenantId);
    if (targets.length === 0) return;

    const doFetch = this.d.fetchImpl ?? fetch;
    const body = JSON.stringify({
      intentId: event.intentId,
      seq: event.seq,
      name: event.name,
      state: event.state,
      correlationId: event.correlationId,
      data: event.data,
      occurredAt: event.occurredAt,
    });
    const timestampSec = Math.floor(this.clock() / 1000);

    for (const target of targets) {
      // The timestamp is INSIDE the signed material, so a captured delivery cannot be replayed later
      // with a fresh one.
      const mac = createHmac("sha256", target.secret)
        .update(webhookSigningPayload(timestampSec, body))
        .digest("hex");
      try {
        await doFetch(target.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "untch-signature": webhookSignatureHeader(timestampSec, mac),
            "untch-event": event.name,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
      } catch (err) {
        this.log("[consumer] webhook delivery failed", {
          endpointId: target.endpointId,
          reason: (err as Error).message,
        });
      }
    }
  }
}

/**
 * Attach an SSE stream: replay everything after the resume cursor from the DURABLE record, then
 * subscribe to the live fan-out. The replay-before-attach order is what makes the sequence gapless —
 * an event that lands between the two is simply delivered twice, and the client dedupes on `seq`,
 * which is far better than one that is missed.
 */
export async function attachSseStream(args: {
  readonly store: ConsumerStore;
  readonly hub: SseHub;
  readonly intentId: string;
  readonly lastEventId: unknown;
  readonly subscriber: SseSubscriber;
  readonly replayLimit?: number;
}): Promise<() => void> {
  const cursor = parseLastEventId(args.lastEventId);
  const missed = await args.store.eventsSince(args.intentId, cursor, args.replayLimit ?? 500);
  for (const event of missed) args.subscriber.write(toSseFrame(event));
  return args.hub.subscribe(args.subscriber);
}

export { webhookRetryDelayMs };
