/**
 * §7.4 "BATCHED (N receipts or T secs)" — the trigger only. It decides WHEN to flush; the actual
 * claim-and-submit is the injected `flush` callback (which pulls the durable QUEUED rows). Kept free
 * of any DB/chain/timer globals so both triggers are unit-testable with a fake scheduler and no I/O.
 *
 *   • size trigger: as soon as `notify` pushes the pending count to >= maxBatchSize, flush now.
 *   • time  trigger: the first receipt after an idle period arms a maxWaitMs timer; if it fires
 *     before the size threshold is hit, flush then. So a trickle of receipts still anchors within T.
 *
 * Flushes are serialized: a trigger during an in-flight flush is coalesced, never overlapped.
 */

export type FlushReason = "size" | "time";

type TimerHandle = unknown;

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface BatcherOptions {
  readonly maxBatchSize: number;
  readonly maxWaitMs: number;
  readonly flush: (reason: FlushReason) => Promise<void>;
  readonly scheduler?: Scheduler;
  readonly onError?: (err: unknown) => void;
}

export class Batcher {
  private readonly maxBatchSize: number;
  private readonly maxWaitMs: number;
  private readonly flush: (reason: FlushReason) => Promise<void>;
  private readonly scheduler: Scheduler;
  private readonly onError: (err: unknown) => void;

  private pending = 0;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: BatcherOptions) {
    this.maxBatchSize = opts.maxBatchSize;
    this.maxWaitMs = opts.maxWaitMs;
    this.flush = opts.flush;
    this.scheduler = opts.scheduler ?? realScheduler;
    this.onError = opts.onError ?? (() => {});
  }

  /** Record `count` newly-queued receipts and fire the size trigger if the threshold is reached. */
  notify(count = 1): void {
    if (this.stopped) return;
    this.pending += count;
    if (this.pending >= this.maxBatchSize) {
      this.trigger("size");
    } else if (this.timer === null) {
      this.timer = this.scheduler.setTimeout(() => this.trigger("time"), this.maxWaitMs);
    }
  }

  private trigger(reason: FlushReason): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = 0;
    this.inFlight = this.inFlight
      .then(() => this.flush(reason))
      .catch((err) => this.onError(err));
  }

  /** Flush anything still pending and stop arming new timers. Awaits the in-flight chain. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    this.trigger("time");
    await this.inFlight;
  }

  /** Test/introspection helper: current pending count. */
  get pendingCount(): number {
    return this.pending;
  }

  /** Resolves when the current (and any queued) flush settles — lets tests await a trigger's effect
   *  without reaching into internals. */
  whenIdle(): Promise<void> {
    return this.inFlight;
  }
}
