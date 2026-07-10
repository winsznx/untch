import assert from "node:assert/strict";
import { test } from "node:test";
import { Batcher, type FlushReason } from "../src/batcher";
import { FakeScheduler } from "./helpers";

/**
 * §7.4 "BATCHED (N receipts or T secs)" — both triggers must fire correctly and independently.
 */

test("N-receipts trigger: reaching maxBatchSize flushes immediately (reason 'size')", async () => {
  const scheduler = new FakeScheduler();
  const reasons: FlushReason[] = [];
  const batcher = new Batcher({
    maxBatchSize: 3,
    maxWaitMs: 10_000,
    scheduler,
    flush: async (reason) => {
      reasons.push(reason);
    },
  });

  batcher.notify(1);
  batcher.notify(1);
  assert.equal(reasons.length, 0, "must not flush before the 3rd receipt");
  assert.equal(scheduler.pendingTimers, 1, "a time-trigger timer is armed while under threshold");

  batcher.notify(1); // hits maxBatchSize = 3
  await batcher.whenIdle();

  assert.deepEqual(reasons, ["size"], "flush fired once, by the size trigger");
  assert.equal(scheduler.pendingTimers, 0, "the pending time timer was cleared by the size flush");
  assert.equal(batcher.pendingCount, 0);
});

test("T-seconds trigger: a lone receipt flushes after maxWaitMs (reason 'time')", async () => {
  const scheduler = new FakeScheduler();
  const reasons: FlushReason[] = [];
  const batcher = new Batcher({
    maxBatchSize: 10, // high, so size never triggers
    maxWaitMs: 1_000,
    scheduler,
    flush: async (reason) => {
      reasons.push(reason);
    },
  });

  batcher.notify(1);
  assert.equal(reasons.length, 0, "must not flush before T elapses");

  scheduler.advance(999);
  assert.equal(reasons.length, 0, "still waiting at T-1ms");

  scheduler.advance(1);
  await batcher.whenIdle();

  assert.deepEqual(reasons, ["time"], "flush fired once, by the time trigger");
  assert.equal(scheduler.pendingTimers, 0);
});

test("N-trigger takes precedence over an armed T-trigger", async () => {
  const scheduler = new FakeScheduler();
  const reasons: FlushReason[] = [];
  const batcher = new Batcher({
    maxBatchSize: 2,
    maxWaitMs: 5_000,
    scheduler,
    flush: async (reason) => {
      reasons.push(reason);
    },
  });

  batcher.notify(1); // arms the timer
  batcher.notify(1); // hits size
  await batcher.whenIdle();

  scheduler.advance(5_000); // the (cleared) timer must not fire a second flush

  assert.deepEqual(reasons, ["size"], "only the size flush happened; the timer was cancelled");
});
