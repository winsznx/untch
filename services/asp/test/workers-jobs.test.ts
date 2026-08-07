import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { buildJobs, requiredCrons, type JobDeps } from "../src/workers/jobs";
import { __resetJobHealth, runScheduled, jobHealthSnapshot } from "../src/workers/scheduled";
import { writerGate } from "../src/workers/writer-gate";

/**
 * The concrete jobs, and the property that matters before cutover: a Cron Trigger cannot mutate
 * staged production while Railway owns writes.
 */

function deps(gateFlag: string | undefined, onRun: (name: string) => void): JobDeps {
  const body = (name: string) => async (): Promise<number> => {
    onRun(name);
    return 1;
  };
  return {
    gate: writerGate(gateFlag),
    reconcileServiceCalls: body("reconcileServiceCalls"),
    projectDeliveries: body("projectDeliveries"),
    recoverUnpublishedDeliveries: body("recoverUnpublishedDeliveries"),
    deliverQueued: body("deliverQueued"),
    expireApprovals: body("expireApprovals"),
    expireReservations: body("expireReservations"),
    recoverAbandonedActions: body("recoverAbandonedActions"),
    reconcileReceipts: body("reconcileReceipts"),
    observeTreasury: body("observeTreasury"),
    snapshotOperationalHealth: body("snapshotOperationalHealth"),
  };
}

function pool() {
  const statements: string[] = [];
  const record = async (sql: string): Promise<{ rows: unknown[] }> => {
    statements.push(sql.trim().split("\n")[0]!.trim());
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
    return { rows: [] };
  };
  return { pool: { query: record, async connect() { return { query: record, release() {} }; } } as never, statements };
}

beforeEach(() => __resetJobHealth());

describe("the job set matches the loops the Node deployment ran", () => {
  test("all eleven jobs are defined with unique names", () => {
    const jobs = buildJobs(deps(undefined, () => {}));
    const names = jobs.map((j) => j.name);
    assert.equal(new Set(names).size, names.length, "job ids must be unique");
    for (const required of [
      "payment-reconciliation",
      "service-call-reconciliation",
      "delivery-recovery",
      "outbox-publication-recovery",
      "delivery-projection",
      "approval-expiry",
      "reservation-expiry",
      "abandoned-action-recovery",
      "receipt-reconciliation",
      "treasury-observation",
      "operational-health-snapshot",
    ]) {
      assert.ok(names.includes(required), `${required} must be wired`);
    }
  });

  test("every job is bounded", () => {
    for (const j of buildJobs(deps(undefined, () => {}))) {
      assert.ok(j.limit > 0 && j.limit <= 100, `${j.name} must have a sane batch limit, got ${j.limit}`);
    }
  });

  /**
   * A Cron Trigger cannot fire faster than once a minute, so the 1-second and 2-second Node loops
   * cannot be ported at their original cadence. The Queue carries the fast path now and these are the
   * safety net, which is why a minute is the right resolution.
   */
  test("no job asks for a cadence Cron Triggers cannot deliver", () => {
    for (const cron of requiredCrons(buildJobs(deps(undefined, () => {})))) {
      assert.match(cron, /^(\*|\*\/\d+) /, `${cron} must be a minute-or-slower expression`);
      assert.ok(!cron.includes("/0"), "a zero step is not a schedule");
    }
  });

  test("the cron set is derived from the jobs, so config cannot drift from code", () => {
    const jobs = buildJobs(deps(undefined, () => {}));
    const crons = requiredCrons(jobs);
    for (const j of jobs) assert.ok(crons.includes(j.cron), `${j.name} declares a cron not in the required set`);
  });
});

describe("before cutover, no scheduled tick mutates staged production", () => {
  /**
   * THE PRE-CUTOVER PROPERTY.
   *
   * Railway owns writes. Every job must run, refuse its mutation, and still report success — because
   * refusing is the correct outcome and a job that failed for behaving correctly would poison the
   * health signal exactly when it is needed.
   */
  test("every job refuses its mutation and none of their bodies run", async () => {
    const ran: string[] = [];
    const jobs = buildJobs(deps(undefined, (n) => ran.push(n)));
    const { pool: p, statements } = pool();

    const runs = [];
    for (const cron of requiredCrons(jobs)) runs.push(...(await runScheduled(p, jobs, cron)));

    assert.equal(runs.length, jobs.length, "every job was invoked");
    assert.deepEqual(ran, [], "not one job body executed while the writer gate is closed");
    assert.deepEqual(
      statements.filter((s) => /^(UPDATE|INSERT|DELETE|TRUNCATE)/i.test(s)),
      [],
      "no scheduled tick issued a write",
    );
    for (const r of runs) {
      assert.equal(r.ok, true, `${r.job} must succeed while refusing — refusing is correct before cutover`);
      assert.equal(r.processed, 0);
    }
  });

  test("the refusal is logged so an operator can see it happened", async () => {
    const lines: string[] = [];
    const jobs = buildJobs(deps(undefined, () => {}));
    const { pool: p } = pool();
    await runScheduled(p, jobs, "* * * * *", (l) => lines.push(l));
    assert.ok(lines.some((l) => /refused/.test(l) && /owns production writes/.test(l)));
  });

  /**
   * The gate must not be a permanent block — cutover has to be able to open it, or the migration
   * cannot complete.
   */
  test("with ownership transferred, every job body runs", async () => {
    const ran: string[] = [];
    const jobs = buildJobs(deps("1", (n) => ran.push(n)));
    const { pool: p } = pool();

    for (const cron of requiredCrons(jobs)) await runScheduled(p, jobs, cron);

    assert.ok(ran.length >= 10, `expected every job body to run, got ${ran.length}`);
    assert.ok(ran.includes("reconcileServiceCalls"));
    assert.ok(ran.includes("deliverQueued"));
    assert.ok(ran.includes("observeTreasury"));
  });
});

describe("health is recorded per job", () => {
  test("each job that runs gets its own health entry", async () => {
    const jobs = buildJobs(deps("1", () => {}));
    const { pool: p } = pool();
    for (const cron of requiredCrons(jobs)) await runScheduled(p, jobs, cron);

    const health = jobHealthSnapshot();
    assert.equal(health.length, jobs.length, "every job reports separately");
    for (const h of health) {
      assert.ok(h.lastSuccessAt, `${h.job} must record a last success`);
      assert.equal(h.consecutiveFailures, 0);
    }
  });

  test("one failing job does not mark the others unhealthy", async () => {
    const base = deps("1", () => {});
    const jobs = buildJobs({ ...base, observeTreasury: async () => { throw new Error("rpc down"); } });
    const { pool: p } = pool();
    for (const cron of requiredCrons(jobs)) await runScheduled(p, jobs, cron);

    const health = jobHealthSnapshot();
    const bad = health.filter((h) => h.consecutiveFailures > 0);
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.job, "treasury-observation");
    assert.match(bad[0]!.lastFailureDetail ?? "", /rpc down/);
  });
});
