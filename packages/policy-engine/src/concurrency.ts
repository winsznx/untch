import { evaluateIntent, type EvaluateOptions } from "./evaluate";
import type { Decision, LedgerWindowState, Policy, SpendIntentInput } from "./types";

/**
 * Per-agent serialization for preflight (PRD §7.1: "Concurrency: per-agent Redis lock serializes
 * intents (no budget race)"; threat model §16 "Budget race → per-agent lock").
 *
 * WHY IN-MEMORY IS CORRECT FOR THIS SLICE: the budget race is between two intents FOR THE SAME
 * AGENT arriving concurrently. Within a single Node process they share this event loop, so an
 * in-memory per-agentId async mutex (a Map of chained promises) fully serializes them — the
 * second intent cannot read ledger state until the first has committed its effect. This needs no
 * external service, which is exactly what makes the package testable with nothing running.
 *
 * WHAT CHANGES FOR MULTI-INSTANCE LATER: once preflight runs on more than one process/replica,
 * two racing intents can land on different instances and this in-process lock no longer sees both.
 * The production upgrade (per §7.1) is a distributed lock — a Redis `SET agentId … NX PX` lease
 * around the same read→evaluate→commit critical section — with the on-chain vault epoch accounting
 * (§7.5) as the ultimate backstop. This module's `runExclusive(agentKey, …)` shape is deliberately
 * the same one a Redis-backed implementation drops into.
 */
export class PerAgentLock {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `task` with exclusive access for `agentKey`. Concurrent calls for the SAME key are
   * serialized in arrival order; calls for DIFFERENT keys run in parallel. A throwing task
   * rejects its own caller but never poisons the chain for the next waiter.
   */
  async runExclusive<T>(agentKey: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(agentKey) ?? Promise.resolve();
    // Our section runs only after `prior` settles. `prior` is a previous section's `settled`
    // promise (below), which never rejects, so `task` runs exactly once, after our turn.
    const run = prior.then(() => task());
    // The new tail resolves when our section completes, errors swallowed so one failed section
    // can't break serialization for the next caller.
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(agentKey, settled);
    try {
      return await run;
    } finally {
      // Bound memory: drop the entry only if nobody chained after us.
      if (this.tails.get(agentKey) === settled) this.tails.delete(agentKey);
    }
  }
}

/**
 * The stateful ledger contract for the SERIALIZED entry point. Unlike the pure `evaluateIntent`
 * (which takes an immutable snapshot), this is read and mutated INSIDE the per-agent lock so a
 * second concurrent intent observes the first's committed spend. Real Postgres/Redis wiring is a
 * later step; any object satisfying this interface works (see the in-memory ledger in the tests).
 */
export interface Ledger {
  /** Read the current window snapshot for the agent (called inside the lock, at evaluation time). */
  read(agentKey: string): LedgerWindowState | Promise<LedgerWindowState>;
  /** Apply an APPROVED intent's effect (called inside the lock, before the lock is released). */
  commitApproved(
    agentKey: string,
    intent: SpendIntentInput,
    decision: Decision,
  ): void | Promise<void>;
}

export interface SerializeOptions extends EvaluateOptions {
  /** The lock instance to use. Defaults to a module-level singleton shared across calls. */
  readonly lock?: PerAgentLock;
}

const defaultLock = new PerAgentLock();

/**
 * The outer entry point (§7.1): acquire the per-agent lock, read ledger state, `evaluateIntent`,
 * commit the effect if APPROVED, release. Serializing the read→evaluate→commit critical section
 * is what makes budget checks race-safe — two concurrent intents for the same agent that are each
 * individually within budget but jointly over it can never both APPROVE.
 */
export async function evaluateIntentSerialized(
  intent: SpendIntentInput,
  policy: Policy | null | undefined,
  ledger: Ledger,
  opts?: SerializeOptions,
): Promise<Decision> {
  const lock = opts?.lock ?? defaultLock;
  const agentKey = String(intent.buyerAgentId);
  return lock.runExclusive(agentKey, async () => {
    const state = await ledger.read(agentKey);
    const decision = evaluateIntent(intent, policy, state, opts);
    if (decision.decision === "APPROVED") {
      await ledger.commitApproved(agentKey, intent, decision);
    }
    return decision;
  });
}
