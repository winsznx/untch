import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GATED_MUTATIONS,
  WRITER_ACTIVE_VALUE,
  WriterGateClosedError,
  assertOwnsWrites,
  cutoverPosture,
  ifOwnsWrites,
  writerGate,
} from "../src/workers/writer-gate";
import { armingState } from "../src/workers/arming";
import { runJob, __resetJobHealth, type ScheduledJob } from "../src/workers/scheduled";
import { consumeDeliveryBatch, type QueueMessage } from "../src/workers/queue-delivery";

/**
 * The control that stops two deployments writing one ledger.
 *
 * Financial arming and write ownership are different questions, and the migration is in exactly the
 * state where they come apart: Railway owns writes, the Worker is deployed and healthy against the
 * SAME database, and a reconciliation sweep is not a financial authorisation — so the arming gate
 * would not stop it.
 */

describe("write ownership is a separate control from financial arming", () => {
  test("only the exact value transfers write ownership", () => {
    assert.equal(writerGate(WRITER_ACTIVE_VALUE).ownsWrites, true);
    for (const flag of [undefined, "", "0", "false", "true", "yes", "on", "enabled", "01", "1x"]) {
      assert.equal(writerGate(flag).ownsWrites, false, `${JSON.stringify(flag)} must not transfer ownership`);
    }
  });

  test("a closed gate explains itself to an operator", () => {
    const g = writerGate(undefined);
    assert.equal(g.mode, "READ_ONLY");
    assert.match(g.reason ?? "", /another deployment owns production writes/);
  });

  /**
   * THE COMBINATION THIS EXISTS FOR.
   *
   * Disarmed but writer-active, or armed but read-only, are both reachable and both meaningful. A
   * single boolean could not express the pre-cutover state: financially disarmed AND not the writer.
   */
  test("the two gates are independent", () => {
    const disarmed = armingState({ attested: true, schema: { ok: true, applied: 35, head: "035" }, armedFlag: undefined });
    const armed = armingState({ attested: true, schema: { ok: true, applied: 35, head: "035" }, armedFlag: "1" });

    assert.deepEqual(cutoverPosture(disarmed.armed, writerGate(undefined)), {
      financiallyArmed: false,
      productionWriter: "elsewhere",
      scheduledMutations: "disabled",
      queueMutations: "disabled",
    });

    // Armed but still not the writer: valid, and still refuses every mutation.
    const halfway = cutoverPosture(armed.armed, writerGate(undefined));
    assert.equal(halfway.financiallyArmed, true);
    assert.equal(halfway.scheduledMutations, "disabled", "arming alone must not enable sweeps");
  });

  test("the pre-cutover posture is the documented one", () => {
    const posture = cutoverPosture(false, writerGate(undefined));
    assert.equal(posture.financiallyArmed, false);
    assert.equal(posture.productionWriter, "elsewhere");
    assert.equal(posture.scheduledMutations, "disabled");
    assert.equal(posture.queueMutations, "disabled");
  });
});

describe("every gated mutation refuses while the gate is closed", () => {
  const closed = writerGate(undefined);
  const open = writerGate("1");

  for (const mutation of GATED_MUTATIONS) {
    test(`${mutation} refuses while closed and proceeds when open`, () => {
      assert.throws(() => assertOwnsWrites(closed, mutation), WriterGateClosedError);
      assert.doesNotThrow(() => assertOwnsWrites(open, mutation));
    });
  }

  test("the refusal names the mutation, so a log says what was declined", () => {
    try {
      assertOwnsWrites(closed, "reservation-expiry-mutation");
      assert.fail("should have refused");
    } catch (e) {
      assert.ok(e instanceof WriterGateClosedError);
      assert.equal(e.mutation, "reservation-expiry-mutation");
    }
  });

  /**
   * A refused mutation before cutover is the correct outcome, not an error. A job that threw would
   * report itself unhealthy for behaving exactly as intended.
   */
  test("ifOwnsWrites reports a refusal rather than throwing", async () => {
    let ran = false;
    const out = await ifOwnsWrites(closed, "delivery-publication", async () => {
      ran = true;
      return "sent";
    });
    assert.equal(ran, false, "the body must not run");
    assert.deepEqual(out, { ran: false, refused: "delivery-publication" });

    const opened = await ifOwnsWrites(open, "delivery-publication", async () => "sent");
    assert.deepEqual(opened, { ran: true, result: "sent" });
  });
});

describe("a Cron Trigger cannot mutate while the writer gate is off", () => {
  /**
   * A pool stand-in that grants the advisory lock and records every statement issued.
   *
   * `query` is exposed on the POOL as well as on a connection, because the job body calls
   * `ctx.pool.query(...)`. An earlier version of this stub had only `connect()`, so the write attempt
   * threw before reaching the gate and the no-writes assertion passed for the wrong reason — it would
   * have passed with the gate removed entirely. Worth stating: a test that cannot fail is not a test.
   */
  function recordingPool() {
    const statements: string[] = [];
    const record = async (sql: string): Promise<{ rows: unknown[] }> => {
      statements.push(sql.trim().split("\n")[0]!.trim());
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      return { rows: [] };
    };
    const pool = {
      query: record,
      async connect() {
        return { query: record, release() {} };
      },
    } as never;
    return { pool, statements };
  }

  test("a reconciliation job runs, refuses its mutation, and issues no write", async () => {
    __resetJobHealth();
    const { pool, statements } = recordingPool();
    const gate = writerGate(undefined);
    let refused: string | null = null;

    const job: ScheduledJob = {
      name: "payment-reconciliation",
      cron: "*/5 * * * *",
      limit: 50,
      run: async (ctx) => {
        const out = await ifOwnsWrites(gate, "payment-reconciliation-write", async () => {
          await (ctx.pool as never as { query: (s: string) => Promise<unknown> }).query("UPDATE untch_x402_payment_attempts SET state = 'SETTLED'");
          return 1;
        });
        if (!out.ran) refused = out.refused;
        return out.ran ? out.result : 0;
      },
    };

    const run = await runJob(pool, job);

    assert.equal(run.ok, true, "refusing is a healthy outcome before cutover, not a failure");
    assert.equal(run.processed, 0);
    assert.equal(refused, "payment-reconciliation-write");

    const writes = statements.filter((s) => /^(UPDATE|INSERT|DELETE|TRUNCATE)/i.test(s));
    assert.deepEqual(writes, [], "a scheduled tick must issue no write while the gate is closed");
  });

  test("the same job does write once ownership is transferred", async () => {
    __resetJobHealth();
    const { pool, statements } = recordingPool();
    const gate = writerGate("1");

    await runJob(pool, {
      name: "payment-reconciliation",
      cron: "*/5 * * * *",
      limit: 50,
      run: async (ctx) => {
        const out = await ifOwnsWrites(gate, "payment-reconciliation-write", async () => {
          await (ctx.pool as never as { query: (s: string) => Promise<unknown> }).query("UPDATE untch_x402_payment_attempts SET state = 'SETTLED'");
          return 1;
        });
        return out.ran ? out.result : 0;
      },
    });

    assert.ok(
      statements.some((s) => s.startsWith("UPDATE")),
      "the gate must not be a permanent block — cutover has to be able to open it",
    );
  });
});

describe("a Queue delivery cannot mutate while the writer gate is off", () => {
  function message(body: unknown): QueueMessage & { acked: boolean; retried: number } {
    const m = {
      id: "msg_1",
      body,
      attempts: 1,
      acked: false,
      retried: 0,
      ack() { m.acked = true; },
      retry() { m.retried += 1; },
    };
    return m;
  }

  test("a queue consumer claims nothing and sends nothing while closed", async () => {
    const gate = writerGate(undefined);
    let claims = 0;
    let sends = 0;
    const m = message({ v: 1, deliveryId: "apdl_1" });

    await consumeDeliveryBatch(
      { messages: [m] },
      {
        pool: {} as never,
        claim: async () => {
          const out = await ifOwnsWrites(gate, "delivery-claim", async () => {
            claims += 1;
            return { kind: "claimed" as const, target: { deliveryId: "apdl_1", approvalRequestId: "a", accountId: "b", channelBindingId: "c", channel: "discord", attempts: 0 } };
          });
          // Refusing to claim reads as 'someone else owns this', which is exactly true: Railway does.
          return out.ran ? out.result : { kind: "held-by-another" as const };
        },
        deliverOne: async () => {
          sends += 1;
          return { outcome: "sent" };
        },
      },
    );

    assert.equal(claims, 0, "no row may be claimed while another deployment owns writes");
    assert.equal(sends, 0, "and nothing may be sent");
    assert.equal(m.acked, true, "the message is acked, not left to redeliver forever");
  });

  test("publication is gated too, so a queue cannot be filled behind the gate", async () => {
    const gate = writerGate(undefined);
    let published = 0;
    const out = await ifOwnsWrites(gate, "delivery-publication", async () => {
      published += 1;
      return published;
    });
    assert.equal(published, 0);
    assert.equal(out.ran, false);
  });
});

describe("the gated-mutation list is the inventory", () => {
  test("every mutation named in the cutover plan is present", () => {
    for (const required of [
      "payment-reconciliation-write",
      "service-call-finalisation-write",
      "approval-expiry-mutation",
      "reservation-expiry-mutation",
      "delivery-publication",
      "delivery-claim",
      "outbox-recovery-publication",
      "receipt-persistence",
      "treasury-observation-persistence",
      "operational-snapshot-row",
    ] as const) {
      assert.ok(GATED_MUTATIONS.includes(required), `${required} must be gated`);
    }
  });
});
