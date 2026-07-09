import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PerAgentLock,
  evaluateIntent,
  evaluateIntentSerialized,
  type Decision,
  type Ledger,
  type LedgerWindowState,
  type Policy,
  type SpendIntentInput,
} from "../src/index";
import { activePolicy, now, validIntent } from "./helpers";

/**
 * The lock proof. The budget race is: two intents for the SAME agent, each individually within
 * budget but jointly over it. The interesting test is not "the lock works" asserted on faith —
 * it is that the SAME scenario double-approves WITHOUT the lock and is correctly serialized WITH
 * it. Both are asserted below, so the passing locked test is meaningful.
 */

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-memory ledger tracking only per-agent daily spend. `read` and `commitApproved` both await a
 * macrotask, which is what lets two concurrent flows interleave (both read the stale total before
 * either commits) when they are NOT serialized — i.e. it makes the race real, not theoretical.
 */
class InMemoryLedger implements Ledger {
  private readonly spent = new Map<string, number>();
  constructor(private readonly delayMs = 5) {}

  async read(agentKey: string): Promise<LedgerWindowState> {
    await tick(this.delayMs);
    return {
      spentTodayByAgent: this.spent.get(agentKey) ?? 0,
      recentIntents: [],
      lastCallByService: {},
      callsInLastHour: 0,
    };
  }

  async commitApproved(agentKey: string, intent: SpendIntentInput, _decision: Decision): Promise<void> {
    await tick(this.delayMs);
    this.spent.set(agentKey, (this.spent.get(agentKey) ?? 0) + intent.amount);
  }

  total(agentKey: string): number {
    return this.spent.get(agentKey) ?? 0;
  }
}

/** read → evaluate → commit, WITHOUT the lock — identical to evaluateIntentSerialized's inner
 *  task minus the mutex, so the two tests differ in exactly one thing: serialization. */
async function runUnlocked(
  intent: SpendIntentInput,
  policy: Policy,
  ledger: InMemoryLedger,
): Promise<Decision> {
  const agentKey = String(intent.buyerAgentId);
  const state = await ledger.read(agentKey);
  const decision = evaluateIntent(intent, policy, state, { now });
  if (decision.decision === "APPROVED") await ledger.commitApproved(agentKey, intent, decision);
  return decision;
}

// Two distinct intents for the SAME agent (id 1): each 15 USDT, daily budget 25 ⇒ each fits
// alone (15 ≤ 25), together they don't (30 > 25). `maxAmount` is set well above 15 (in base units,
// 6dp) so the intent-bound rule passes and the budget rule stays the discriminator this test is about.
const AGENT = 1n;
const HIGH_MAX = 1_000_000_000n; // 1000 USDT in 6-decimal base units
const intentA = validIntent({ buyerAgentId: AGENT, nonce: 1n, amount: 15, maxAmount: HIGH_MAX, taskHash: `0x${"a1".repeat(32)}` });
const intentB = validIntent({ buyerAgentId: AGENT, nonce: 2n, amount: 15, maxAmount: HIGH_MAX, taskHash: `0x${"b2".repeat(32)}` });
const policy = activePolicy();

describe("budget race", () => {
  test("WITHOUT the lock, the SAME scenario double-approves (proves the test is real)", async () => {
    // #given a fresh ledger and two concurrent same-agent intents (15 + 15 vs daily 25)
    const ledger = new InMemoryLedger();
    // #when both run concurrently with NO serialization
    const results = await Promise.all([
      runUnlocked(intentA, policy, ledger),
      runUnlocked(intentB, policy, ledger),
    ]);
    // #then both approve and the agent overspends its daily budget — the exact bug the lock prevents
    const approved = results.filter((r) => r.decision === "APPROVED").length;
    assert.equal(approved, 2, "unlocked path must double-approve for the locked test to be meaningful");
    assert.equal(ledger.total(String(AGENT)), 30, "unlocked path overspends past the 25 daily budget");
  });

  test("WITH the per-agent lock, exactly one APPROVED and one BLOCKED_BUDGET — never both", async () => {
    // #given a fresh ledger, a shared lock, and the identical two intents
    const ledger = new InMemoryLedger();
    const lock = new PerAgentLock();
    // #when both run concurrently through the serialized entry point
    const results = await Promise.all([
      evaluateIntentSerialized(intentA, policy, ledger, { now, lock }),
      evaluateIntentSerialized(intentB, policy, ledger, { now, lock }),
    ]);
    // #then the second sees the first's committed spend and is blocked
    const outcomes = results.map((r) => r.decision).sort();
    assert.deepEqual(outcomes, ["APPROVED", "BLOCKED_BUDGET"]);
    assert.equal(results.filter((r) => r.decision === "APPROVED").length, 1, "never both APPROVED");
    assert.equal(ledger.total(String(AGENT)), 15, "only the one approved spend is committed");
  });
});

describe("PerAgentLock.runExclusive", () => {
  test("serializes tasks for the same key (no interleave)", async () => {
    const lock = new PerAgentLock();
    const log: string[] = [];
    const job = (id: string, ms: number) => async (): Promise<void> => {
      log.push(`start:${id}`);
      await tick(ms);
      log.push(`end:${id}`);
    };
    await Promise.all([lock.runExclusive("A", job("A1", 10)), lock.runExclusive("A", job("A2", 1))]);
    assert.deepEqual(log, ["start:A1", "end:A1", "start:A2", "end:A2"]);
  });

  test("runs tasks for different keys concurrently (they overlap)", async () => {
    const lock = new PerAgentLock();
    const log: string[] = [];
    await Promise.all([
      lock.runExclusive("A", async () => {
        log.push("A-start");
        await tick(10);
        log.push("A-end");
      }),
      lock.runExclusive("B", async () => {
        log.push("B-start");
        await tick(1);
        log.push("B-end");
      }),
    ]);
    assert.deepEqual(log, ["A-start", "B-start", "B-end", "A-end"]);
  });

  test("a throwing task does not poison the chain for the next waiter", async () => {
    const lock = new PerAgentLock();
    await assert.rejects(lock.runExclusive("K", async () => Promise.reject(new Error("boom"))));
    // the next call on the same key must still run
    const ran = await lock.runExclusive("K", async () => 42);
    assert.equal(ran, 42);
  });
});
