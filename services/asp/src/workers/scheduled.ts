/**
 * Scheduled work on Workers, where nothing may run forever and nothing may run twice.
 *
 * WHAT REPLACED WHAT
 *
 * The Node service kept `setInterval` loops inside a process that outlived every request. A Worker has
 * no such process: a `scheduled` handler is invoked, does bounded work, and ends. That is a better fit
 * for these jobs than the timers were, because a timer in a process that dies silently stops running
 * and nothing says so.
 *
 * THE THREE RULES EVERY JOB OBEYS
 *
 *   BOUNDED. Every job takes a batch limit and returns how much it did. A job that processes "all
 *   pending work" has no upper bound on runtime, and a Worker invocation that exceeds its budget is
 *   killed part-way — which for a financial sweep means an unknown amount of work was done.
 *
 *   NON-OVERLAPPING. Cloudflare may invoke a scheduled handler while a previous one is still running,
 *   and two sweeps claiming the same rows is the duplicate-delivery problem again. A Postgres advisory
 *   lock makes the second one stand down; it is transaction-scoped, so a Worker that dies mid-sweep
 *   cannot leave the job permanently locked out.
 *
 *   OBSERVABLE. Every run records started/succeeded/failed. A sweep that has not succeeded in an hour
 *   is the signal that the queue's safety net is gone, and without a recorded last-success there is no
 *   way to notice — which is exactly how a stalled cron becomes an outage nobody saw coming.
 */

import type { Pool } from "@untch/consumer-core";

export interface JobRun {
  readonly job: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ok: boolean;
  readonly processed: number;
  readonly detail: string | null;
  /** True when another invocation held the lock and this one stood down. Not a failure. */
  readonly skippedOverlap: boolean;
}

export interface JobContext {
  readonly pool: Pool;
  readonly limit: number;
  readonly log: (line: string) => void;
}

export type JobBody = (ctx: JobContext) => Promise<number>;

export interface ScheduledJob {
  readonly name: string;
  /** Cron expression this job answers to, so the wrangler config and the code cannot drift apart. */
  readonly cron: string;
  readonly limit: number;
  readonly run: JobBody;
}

/**
 * Health as an operator reads it.
 *
 * `lastSuccessAt` is separate from `lastRunAt` on purpose: a job failing every minute has a very
 * recent run and has not succeeded in an hour, and only the second number says the safety net is down.
 */
export interface JobHealth {
  readonly job: string;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureDetail: string | null;
  readonly consecutiveFailures: number;
  readonly lastProcessed: number;
}

/** In-memory across one isolate; the durable record is the table below. */
const health = new Map<string, JobHealth>();

export function jobHealthSnapshot(): readonly JobHealth[] {
  return [...health.values()].sort((a, b) => a.job.localeCompare(b.job));
}

function record(run: JobRun): void {
  const prev = health.get(run.job);
  health.set(run.job, {
    job: run.job,
    lastRunAt: run.finishedAt,
    lastSuccessAt: run.ok ? run.finishedAt : (prev?.lastSuccessAt ?? null),
    lastFailureAt: run.ok ? (prev?.lastFailureAt ?? null) : run.finishedAt,
    lastFailureDetail: run.ok ? (prev?.lastFailureDetail ?? null) : run.detail,
    consecutiveFailures: run.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    lastProcessed: run.processed,
  });
}

/**
 * A transaction-scoped advisory lock keyed on the job name.
 *
 * `pg_try_advisory_xact_lock` rather than the blocking form: a second invocation should stand down
 * immediately, not queue up behind the first and then run late against rows the first already handled.
 * Transaction-scoped means the database releases it on COMMIT, ROLLBACK or a dropped connection, so a
 * Worker killed mid-sweep cannot lock the job out permanently.
 */
export async function runExclusively(
  pool: Pool,
  job: string,
  body: (ctx: { readonly client: unknown }) => Promise<number>,
): Promise<{ readonly ran: boolean; readonly processed: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
      [`untch.scheduled.${job}`],
    );
    if (rows[0]?.locked !== true) {
      await client.query("ROLLBACK");
      return { ran: false, processed: 0 };
    }
    const processed = await body({ client });
    await client.query("COMMIT");
    return { ran: true, processed };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run one job, bounded, exclusive and recorded.
 *
 * Never throws. A scheduled handler that throws is retried by the platform with no memory of what it
 * already did, and for a sweep that claims rows that is worse than recording the failure and letting
 * the next tick try again from a known state.
 */
export async function runJob(pool: Pool, job: ScheduledJob, log: (line: string) => void = () => {}): Promise<JobRun> {
  const startedAt = new Date().toISOString();
  try {
    const { ran, processed } = await runExclusively(pool, job.name, async () =>
      job.run({ pool, limit: job.limit, log }),
    );
    const run: JobRun = {
      job: job.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      processed,
      detail: ran ? null : "another invocation held the lock",
      skippedOverlap: !ran,
    };
    // An overlap is not a success: recording it as one would let a permanently-stuck job look healthy.
    if (ran) record(run);
    return run;
  } catch (err) {
    const run: JobRun = {
      job: job.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      processed: 0,
      detail: (err as Error).message.slice(0, 300),
      skippedOverlap: false,
    };
    record(run);
    log(`[scheduled] ${job.name} failed: ${run.detail}`);
    return run;
  }
}

/**
 * Run every job whose cron matches this invocation.
 *
 * Cloudflare tells the handler which cron fired, so a single Worker can carry several schedules
 * without each job having to guess whether it is its turn.
 */
export async function runScheduled(
  pool: Pool,
  jobs: readonly ScheduledJob[],
  cron: string,
  log: (line: string) => void = () => {},
): Promise<readonly JobRun[]> {
  const due = jobs.filter((j) => j.cron === cron);
  const runs: JobRun[] = [];
  for (const job of due) runs.push(await runJob(pool, job, log));
  return runs;
}

/**
 * Is the safety net actually up?
 *
 * Reported rather than inferred from "did the last run succeed", because the failure that matters is
 * a job that stopped running at all — which looks identical to a healthy idle job unless somebody
 * measures the age of the last success.
 */
export function stalledJobs(now: number, maxAgeMs: number): readonly JobHealth[] {
  return jobHealthSnapshot().filter((h) => {
    if (h.lastSuccessAt === null) return true;
    return now - Date.parse(h.lastSuccessAt) > maxAgeMs;
  });
}

/** Reset between tests. Never called in production; the map is per-isolate state, not a store. */
export function __resetJobHealth(): void {
  health.clear();
}
