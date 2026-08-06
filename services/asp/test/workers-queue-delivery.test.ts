import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_DELIVERY_ATTEMPTS,
  consumeDeliveryBatch,
  isDeliveryMessage,
  publishCommittedDeliveries,
  type ClaimOutcome,
  type QueueMessage,
} from "../src/workers/queue-delivery";

/**
 * At-least-once delivery, and the reason it does not produce at-least-twice messages.
 *
 * The database claim is exercised against real Postgres in `workers-queue-delivery-pg`. What is tested
 * here is the CONSUMER's decision table: given each claim outcome, does it send, ack, retry or
 * dead-letter — because that is what decides whether a redelivered message messages a person twice.
 */

function message(body: unknown, attempts = 1): QueueMessage & { acked: boolean; retried: number } {
  const m = {
    id: `msg_${Math.abs(String(body).length)}`,
    body,
    attempts,
    acked: false,
    retried: 0,
    ack() {
      m.acked = true;
    },
    retry() {
      m.retried += 1;
    },
  };
  return m;
}

const target = {
  deliveryId: "apdl_1",
  approvalRequestId: "aprq_1",
  accountId: "acct_1",
  channelBindingId: "cbnd_1",
  channel: "discord",
  attempts: 0,
};

/** The consumer only ever touches the pool through the injected claim, so a stub object suffices. */
const POOL = {} as never;

async function runWith(
  claim: ClaimOutcome | Error,
  msgs: (QueueMessage & { acked: boolean; retried: number })[],
  deliver: () => Promise<{ outcome: "sent" | "retryable" | "terminal" }> = async () => ({ outcome: "sent" }),
) {
  return consumeDeliveryBatch(
    { messages: msgs },
    {
      pool: POOL,
      deliverOne: deliver,
      claim: async () => {
        if (claim instanceof Error) throw claim;
        return claim;
      },
    },
  );
}

describe("the message carries an identifier and nothing else", () => {
  test("a well-formed message is recognised", () => {
    assert.equal(isDeliveryMessage({ v: 1, deliveryId: "apdl_1" }), true);
  });

  test("anything else is refused rather than guessed at", () => {
    for (const bad of [null, undefined, {}, { v: 2, deliveryId: "x" }, { v: 1 }, { v: 1, deliveryId: "" }, "apdl_1", 42]) {
      assert.equal(isDeliveryMessage(bad), false, `${JSON.stringify(bad)} must not be readable`);
    }
  });

  /**
   * The payload must never carry the decision. A message delayed by a day would otherwise act on a
   * world that has moved — a revoked binding, a resolved request, a superseded quote.
   */
  test("the published body contains only a version and an id", async () => {
    const sent: { body: unknown }[] = [];
    await publishCommittedDeliveries(
      { async send() {}, async sendBatch(m) { sent.push(...m); } },
      ["apdl_1", "apdl_2"],
    );
    assert.deepEqual(sent.map((s) => s.body), [
      { v: 1, deliveryId: "apdl_1" },
      { v: 1, deliveryId: "apdl_2" },
    ]);
    for (const s of sent) {
      assert.deepEqual(Object.keys(s.body as object).sort(), ["deliveryId", "v"], "no channel, recipient, amount or token");
    }
  });
});

describe("publication never fails the request whose durable work already succeeded", () => {
  test("a queue outage is reported, not thrown — the sweep is the recovery path", async () => {
    const lines: string[] = [];
    const out = await publishCommittedDeliveries(
      { async send() {}, async sendBatch() { throw new Error("queue unavailable"); } },
      ["apdl_1"],
      (l) => lines.push(l),
    );
    assert.deepEqual(out, { published: 0, failed: 1 });
    assert.match(lines[0] ?? "", /sweep will recover/);
  });

  test("publishing nothing does nothing", async () => {
    let called = false;
    const out = await publishCommittedDeliveries({ async send() {}, async sendBatch() { called = true; } }, []);
    assert.deepEqual(out, { published: 0, failed: 0 });
    assert.equal(called, false);
  });
});

describe("a redelivered message never messages a person twice", () => {
  /**
   * THE PROPERTY THE WHOLE DESIGN EXISTS FOR.
   *
   * At-least-once means the same message can arrive again after it was handled. The consumer re-reads
   * the row, sees a terminal status, and sends nothing.
   */
  test("a message for an already-terminal delivery is acked without sending", async () => {
    let sends = 0;
    const m = message({ v: 1, deliveryId: "apdl_1" });
    const report = await runWith({ kind: "already-terminal", status: "SENT" }, [m], async () => {
      sends += 1;
      return { outcome: "sent" };
    });
    assert.equal(sends, 0, "a finished delivery must not be sent again");
    assert.equal(m.acked, true);
    assert.equal(report.sent, 0);
  });

  for (const status of ["SENT", "ACTED", "INVALIDATED", "FAILED_TERMINAL", "EXPIRED"]) {
    test(`status ${status} suppresses the send`, async () => {
      let sends = 0;
      const m = message({ v: 1, deliveryId: "apdl_1" });
      await runWith({ kind: "already-terminal", status }, [m], async () => {
        sends += 1;
        return { outcome: "sent" };
      });
      assert.equal(sends, 0);
      assert.equal(m.acked, true);
    });
  }

  test("a delivery held by another consumer is acked, not raced", async () => {
    let sends = 0;
    const m = message({ v: 1, deliveryId: "apdl_1" });
    await runWith({ kind: "held-by-another" }, [m], async () => {
      sends += 1;
      return { outcome: "sent" };
    });
    assert.equal(sends, 0, "two consumers must not both send");
    assert.equal(m.acked, true);
  });

  test("a claimed delivery is sent exactly once", async () => {
    let sends = 0;
    const m = message({ v: 1, deliveryId: "apdl_1" });
    const report = await runWith({ kind: "claimed", target }, [m], async () => {
      sends += 1;
      return { outcome: "sent" };
    });
    assert.equal(sends, 1);
    assert.equal(report.sent, 1);
    assert.equal(m.acked, true);
  });
});

describe("failure handling is bounded and explicit", () => {
  test("a nonexistent delivery is acked rather than circulating", async () => {
    const m = message({ v: 1, deliveryId: "apdl_gone" });
    await runWith({ kind: "not-found" }, [m]);
    assert.equal(m.acked, true);
    assert.equal(m.retried, 0);
  });

  test("a not-yet-due delivery is retried with a delay", async () => {
    const m = message({ v: 1, deliveryId: "apdl_1" });
    await runWith({ kind: "not-due" }, [m]);
    assert.equal(m.retried, 1);
    assert.equal(m.acked, false);
  });

  test("a database error retries rather than dropping the delivery", async () => {
    const m = message({ v: 1, deliveryId: "apdl_1" });
    await runWith(new Error("connection reset"), [m]);
    assert.equal(m.retried, 1);
    assert.equal(m.acked, false);
  });

  test("a send that throws retries rather than marking anything", async () => {
    const m = message({ v: 1, deliveryId: "apdl_1" });
    await runWith({ kind: "claimed", target }, [m], async () => {
      throw new Error("discord unreachable");
    });
    assert.equal(m.retried, 1);
    assert.equal(m.acked, false);
  });

  /**
   * Retrying forever is how a poison message occupies a queue indefinitely. Past the limit it is
   * acked so Cloudflare routes it to the dead-letter queue instead.
   */
  test("a message past the attempt limit is dead-lettered rather than retried forever", async () => {
    const m = message({ v: 1, deliveryId: "apdl_1" }, MAX_DELIVERY_ATTEMPTS + 1);
    let sends = 0;
    const report = await runWith({ kind: "claimed", target }, [m], async () => {
      sends += 1;
      return { outcome: "sent" };
    });
    assert.equal(sends, 0, "an exhausted message must not still be delivered");
    assert.equal(m.acked, true);
    assert.equal(report.deadLettered, 1);
  });

  test("an unreadable message is dead-lettered immediately, not retried into the limit", async () => {
    const m = message({ nonsense: true });
    const report = await runWith({ kind: "not-found" }, [m]);
    assert.equal(m.acked, true);
    assert.equal(m.retried, 0, "a shape that will never become readable must not occupy the queue");
    assert.equal(report.deadLettered, 1);
  });

  test("every message in a batch is decided, none left to silent redelivery", async () => {
    const msgs = [
      message({ v: 1, deliveryId: "a" }),
      message({ v: 1, deliveryId: "b" }),
      message({ garbage: 1 }),
    ];
    await runWith({ kind: "claimed", target }, msgs);
    for (const m of msgs) {
      assert.ok(m.acked || m.retried > 0, `message ${m.id} was neither acked nor retried`);
    }
  });
});
