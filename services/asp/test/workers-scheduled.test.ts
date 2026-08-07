import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  __resetJobHealth,
  jobHealthSnapshot,
  runJob,
  runScheduled,
  stalledJobs,
  type ScheduledJob,
} from "../src/workers/scheduled";

/**
 * The scheduled-job framework.
 *
 * The properties under test are the three that make a sweep safe to run on a platform that may invoke
 * it concurrently and kill it part-way: it is bounded, it does not overlap, and a stall is visible.
 */

/** A pool stand-in that reports whether the advisory lock was granted. */
function poolWith(opts: { locked?: boolean; failOn?: string } = {}) {
  const queries: string[] = [];
  const pool = {
    async connect() {
      return {
        async query(sql: string) {
          queries.push(sql.trim().split("\n")[0]!.trim());
          if (opts.failOn && sql.includes(opts.failOn)) throw new Error("database exploded");
          if (sql.includes("pg_try_advisory_xact_lock")) {
            return { rows: [{ locked: opts.locked ?? true }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  } as never;
  return { pool, queries };
}

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  name: "delivery-recovery",
  cron: "*/1 * * * *",
  limit: 100,
  run: async () => 3,
  ...over,
});

beforeEach(() => __resetJobHealth());

describe("a job is bounded and reports what it did", () => {
  test("the batch limit reaches the job body", async () => {
    let seen = -1;
    const { pool } = poolWith();
    await runJob(pool, job({ limit: 42, run: async (ctx) => { seen = ctx.limit; return 0; } }));
    assert.equal(seen, 42, "a job that processes 'everything pending' has no upper bound on runtime");
  });

  test("the processed count is carried back", async () => {
    const { pool } = poolWith();
    const run = await runJob(pool, job({ run: async () => 7 }));
    assert.equal(run.ok, true);
    assert.equal(run.processed, 7);
  });
});

describe("two invocations never sweep the same rows", () => {
  /**
   * Cloudflare may invoke a scheduled handler while a previous one is still running. Two sweeps
   * claiming the same delivery rows is the duplicate-message problem wearing a different hat.
   */
  test("a second invocation stands down when the lock is held", async () => {
    let ran = false;
    const { pool } = poolWith({ locked: false });
    const run = await runJob(pool, job({ run: async () => { ran = true; return 5; } }));

    assert.equal(ran, false, "the body must not run while another invocation holds the lock");
    assert.equal(run.skippedOverlap, true);
    assert.equal(run.processed, 0);
  });

  test("the lock is transaction-scoped, so a killed Worker cannot lock the job out forever", async () => {
    const { pool, queries } = poolWith();
    await runJob(pool, job());
    assert.ok(
      queries.some((q) => q.includes("pg_try_advisory_xact_lock")),
      "must use the transaction-scoped try-lock, not a session lock or a blocking one",
    );
    assert.ok(queries.includes("BEGIN") && queries.includes("COMMIT"));
  });

  /**
   * An overlap must not count as a success. Recording it as one would let a job whose body never runs
   * report a fresh lastSuccessAt forever and look permanently healthy.
   */
  test("an overlap does not refresh the success clock", async () => {
    const { pool } = poolWith({ locked: false });
    await runJob(pool, job());
    assert.deepEqual(jobHealthSnapshot(), [], "a stood-down invocation records nothing");
  });
});

describe("failure is recorded, never thrown", () => {
  /**
   * A scheduled handler that throws is retried by the platform with no memory of what it already did.
   * For a sweep that claims rows, that is worse than recording the failure and starting clean.
   */
  test("a throwing job body returns a failed run rather than propagating", async () => {
    const { pool } = poolWith();
    const run = await runJob(pool, job({ run: async () => { throw new Error("provider unreachable"); } }));

    assert.equal(run.ok, false);
    assert.match(run.detail ?? "", /provider unreachable/);
    assert.equal(run.processed, 0);
  });

  test("a database failure is recorded rather than propagating", async () => {
    const { pool } = poolWith({ failOn: "pg_try_advisory_xact_lock" });
    const run = await runJob(pool, job());
    assert.equal(run.ok, false);
  });

  test("consecutive failures are counted, and a success resets them", async () => {
    const { pool } = poolWith();
    const failing = job({ run: async () => { throw new Error("nope"); } });
    await runJob(pool, failing);
    await runJob(pool, failing);
    assert.equal(jobHealthSnapshot()[0]!.consecutiveFailures, 2);

    await runJob(pool, job());
    const h = jobHealthSnapshot()[0]!;
    assert.equal(h.consecutiveFailures, 0);
    assert.ok(h.lastSuccessAt);
    assert.ok(h.lastFailureAt, "the previous failure stays on the record");
  });
});

describe("a stalled job is visible", () => {
  /**
   * The failure that matters is a job that stopped running at all, which looks identical to a healthy
   * idle job unless the AGE of the last success is measured. lastRunAt alone cannot see it: a job
   * failing every minute has a very recent run and has not succeeded in an hour.
   */
  test("a job that has never succeeded is stalled", async () => {
    const { pool } = poolWith();
    await runJob(pool, job({ run: async () => { throw new Error("down"); } }));
    assert.equal(stalledJobs(Date.now(), 60_000).length, 1);
  });

  test("a job whose last success is older than the threshold is stalled", async () => {
    const { pool } = poolWith();
    await runJob(pool, job());
    assert.equal(stalledJobs(Date.now(), 60_000).length, 0, "just succeeded");
    assert.equal(stalledJobs(Date.now() + 3_600_000, 60_000).length, 1, "an hour later, stalled");
  });

  /**
   * The property is that a later failure does not ERASE the earlier success, so an operator can still
   * see when the safety net last actually worked.
   *
   * Asserted on the record rather than by comparing the two timestamps: back-to-back runs land in the
   * same millisecond, so ISO strings are equal and inequality would be testing the clock's resolution
   * instead of the behaviour.
   */
  test("a later failure preserves the earlier success rather than erasing it", async () => {
    const { pool } = poolWith();
    await runJob(pool, job());
    const afterSuccess = jobHealthSnapshot()[0]!.lastSuccessAt;
    assert.ok(afterSuccess);

    await runJob(pool, job({ run: async () => { throw new Error("later failure"); } }));

    const h = jobHealthSnapshot()[0]!;
    assert.equal(h.lastSuccessAt, afterSuccess, "the success record survives a subsequent failure");
    assert.ok(h.lastFailureAt, "and the failure is recorded alongside it");
    assert.match(h.lastFailureDetail ?? "", /later failure/);
    assert.equal(h.consecutiveFailures, 1, "one failure since the last success");
  });
});

describe("only the jobs due for this cron run", () => {
  test("a matching cron runs and a non-matching one does not", async () => {
    const ran: string[] = [];
    const { pool } = poolWith();
    const jobs = [
      job({ name: "delivery-recovery", cron: "*/1 * * * *", run: async () => { ran.push("delivery"); return 1; } }),
      job({ name: "payment-reconciliation", cron: "*/5 * * * *", run: async () => { ran.push("payment"); return 1; } }),
      job({ name: "expiry-sweep", cron: "*/5 * * * *", run: async () => { ran.push("expiry"); return 1; } }),
    ];

    await runScheduled(pool, jobs, "*/5 * * * *");
    assert.deepEqual(ran, ["payment", "expiry"], "only the five-minute jobs");

    ran.length = 0;
    await runScheduled(pool, jobs, "*/1 * * * *");
    assert.deepEqual(ran, ["delivery"]);
  });

  test("one failing job does not prevent the others in the same tick", async () => {
    const ran: string[] = [];
    const { pool } = poolWith();
    const runs = await runScheduled(pool, [
      job({ name: "a", cron: "c", run: async () => { throw new Error("boom"); } }),
      job({ name: "b", cron: "c", run: async () => { ran.push("b"); return 2; } }),
    ], "c");

    assert.deepEqual(ran, ["b"]);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.ok, false);
    assert.equal(runs[1]!.ok, true);
  });

  test("an unknown cron runs nothing rather than everything", async () => {
    const { pool } = poolWith();
    const runs = await runScheduled(pool, [job({ cron: "*/1 * * * *" })], "0 0 * * *");
    assert.deepEqual(runs, []);
  });
});
