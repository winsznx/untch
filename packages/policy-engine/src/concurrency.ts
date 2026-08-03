import { canonUrl } from "@untch/canon";
import { evaluateIntent, type EvaluateOptions } from "./evaluate";
import { proposeDecisionEffects, type DecisionEffects } from "./effects";
import type { Decision, LedgerWindowState, Policy, SpendIntentInput } from "./types";

/**
 * The partition key for ALL per-caller ephemeral preflight state — the budget window, rolling-hour
 * rate limit, duplicate/cooldown clocks, AND the serialization lock. It is the POLICY ID, never the
 * raw `buyerAgentId`.
 *
 * WHY POLICY ID AND NOT `buyerAgentId`: `buyerAgentId` is an unqualified, caller-supplied value that
 * is often literally the ubiquitous "1" across unrelated demo/test agents. Two different owners whose
 * agents happen to share that value would otherwise collapse into ONE budget bucket, one rate limit,
 * one duplicate/cooldown state, and one lock — one tenant's spend silently eating another's. The
 * durable schema makes the correct key obvious: `policies.id` is the PRIMARY KEY (the on-chain
 * `uint256(keccak256(owner, ownerNonce))`), and each policy row governs exactly one agent via a single
 * immutable `policies.agent_id`. So policyId → agent is a function: policyId ALONE already determines
 * the agent, and two different owners always get distinct policyIds even when their `agent_id` values
 * collide on "1". A compound `(policyId, agentId)` key would be redundant — policyId already implies
 * agentId — so policyId is the correct, minimal key. And the budget itself lives in the policy's rules,
 * so spend MUST be counted per-policy anyway, not per-agent.
 *
 * NO-ACTIVE-POLICY PATH: when no stored policy resolves, the intent fail-closes to
 * BLOCKED_NO_ACTIVE_POLICY (I2) without ever reading a meaningful window or committing spend, so all
 * such requests share a single reserved `policy:∅` partition — safe because there is no tenant budget
 * to isolate on that path.
 */
export function ledgerPartitionKey(policyId: string | null | undefined): string {
  return `policy:${policyId ?? "∅"}`;
}

/**
 * Per-partition serialization for preflight (PRD §7.1: "Concurrency: per-agent Redis lock serializes
 * intents (no budget race)"; threat model §16 "Budget race → per-agent lock"). The lock is keyed by
 * the `ledgerPartitionKey` (policyId) so racing intents for the SAME policy serialize while different
 * policies — including different owners' agents that collide on `buyerAgentId` — run in parallel.
 *
 * WHY IN-MEMORY IS CORRECT FOR THIS SLICE: the budget race is between two intents FOR THE SAME
 * PARTITION arriving concurrently. Within a single Node process they share this event loop, so an
 * in-memory per-partition async mutex (a Map of chained promises) fully serializes them — the
 * second intent cannot read ledger state until the first has committed its effect. This needs no
 * external service, which is exactly what makes the package testable with nothing running.
 *
 * WHAT CHANGES FOR MULTI-INSTANCE LATER (separate, already-accepted item — NOT fixed here): once
 * preflight runs on more than one process/replica, two racing intents can land on different instances
 * and this in-process lock no longer sees both; likewise the ledger window is per-process and resets
 * on restart. Durability + cross-instance sharing is the same known, lower-priority characteristic as
 * the intent store's, deferred to §7.1's distributed-lock upgrade — a Redis `SET policyId … NX PX`
 * lease around the same read→evaluate→commit critical section, with the on-chain vault epoch
 * accounting (§7.5) as the ultimate backstop. This module's `runExclusive(partitionKey, …)` shape is
 * deliberately the same one a Redis-backed implementation drops into.
 */
export class PerAgentLock {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `task` with exclusive access for `partitionKey`. Concurrent calls for the SAME key are
   * serialized in arrival order; calls for DIFFERENT keys run in parallel. A throwing task
   * rejects its own caller but never poisons the chain for the next waiter.
   */
  async runExclusive<T>(partitionKey: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(partitionKey) ?? Promise.resolve();
    // Our section runs only after `prior` settles. `prior` is a previous section's `settled`
    // promise (below), which never rejects, so `task` runs exactly once, after our turn.
    const run = prior.then(() => task());
    // The new tail resolves when our section completes, errors swallowed so one failed section
    // can't break serialization for the next caller.
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(partitionKey, settled);
    try {
      return await run;
    } finally {
      // Bound memory: drop the entry only if nobody chained after us.
      if (this.tails.get(partitionKey) === settled) this.tails.delete(partitionKey);
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
  /** Read the current window snapshot for the partition (called inside the lock, at evaluation time). */
  read(partitionKey: string): LedgerWindowState | Promise<LedgerWindowState>;
  /** Apply an APPROVED intent's effect (called inside the lock, before the lock is released). */
  commitApproved(
    partitionKey: string,
    intent: SpendIntentInput,
    decision: Decision,
  ): void | Promise<void>;
}

export interface SerializeOptions extends EvaluateOptions {
  /** The lock instance to use. Defaults to a module-level singleton shared across calls. */
  readonly lock?: PerAgentLock;
}

const defaultLock = new PerAgentLock();

/** The service identity the cooldown rule keys on — an endpoint's canonical host. */
function serviceHostOf(endpoint: string): string {
  try {
    return new URL(canonUrl(endpoint)).host;
  } catch {
    // A non-URL endpoint has no host to key a cooldown on. The rule treats an absent key as "no
    // prior call", which is the same answer it would give for a service never called — correct, and
    // better than inventing a key two different endpoints could share.
    return endpoint;
  }
}

/**
 * Judge an intent and PROPOSE what committing it would change. Writes nothing.
 *
 * This is the function every caller should reach for. `evaluateIntentSerialized` below is kept for
 * the callers that still hand it a mutable ledger, and is now implemented in terms of this one, so
 * there is a single definition of what a decision is and what it would change.
 *
 * WHY THE SNAPSHOT IS A PARAMETER
 *
 * The state is read by the caller, inside whatever transaction the caller controls, and handed here
 * as an immutable value. That is what makes the validation path safe: it can read a snapshot, get a
 * real decision, and discard the proposal — with no code path through which a mutation could occur,
 * rather than a flag saying one should not.
 */
export function proposeDecision(
  intent: SpendIntentInput,
  policy: Policy | null | undefined,
  state: LedgerWindowState,
  opts?: EvaluateOptions & { readonly nowMs?: number },
): { readonly decision: Decision; readonly effects: DecisionEffects | null } {
  const decision = evaluateIntent(intent, policy, state, opts);
  const nowMs = opts?.nowMs ?? opts?.now?.() ?? Date.now();
  const effects = proposeDecisionEffects({
    partitionKey: ledgerPartitionKey(policy?.id),
    intent,
    decision,
    nowMs,
    serviceHost: serviceHostOf(intent.endpoint),
  });
  return { decision, effects };
}

/**
 * The outer entry point (§7.1): acquire the per-partition (policyId) lock, read ledger state,
 * `evaluateIntent`, commit the effect if APPROVED, release. Serializing the read→evaluate→commit
 * critical section is what makes budget checks race-safe — two concurrent intents for the same
 * policy that are each individually within budget but jointly over it can never both APPROVE.
 */
export async function evaluateIntentSerialized(
  intent: SpendIntentInput,
  policy: Policy | null | undefined,
  ledger: Ledger,
  opts?: SerializeOptions,
): Promise<Decision> {
  const lock = opts?.lock ?? defaultLock;
  const partitionKey = ledgerPartitionKey(policy?.id);
  return lock.runExclusive(partitionKey, async () => {
    const state = await ledger.read(partitionKey);
    // Implemented through `proposeDecision` so there is ONE definition of what a decision is and what
    // committing it would change. This path then applies the proposal; the decision-only path does not.
    const { decision } = proposeDecision(intent, policy, state, opts);
    if (decision.decision === "APPROVED") {
      await ledger.commitApproved(partitionKey, intent, decision);
    }
    return decision;
  });
}
