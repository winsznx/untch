/**
 * What a decision WOULD change, proposed rather than applied.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 *
 * `evaluateIntentSerialized` read the ledger, evaluated, and — on APPROVED — called
 * `ledger.commitApproved` before returning. The commit went to a process singleton, outside any
 * caller transaction. So the always-rollback validation route, which exists precisely to change
 * nothing, changed something anyway: the in-process duplicate window, the daily spend, the rolling
 * rate counter. A rolled-back validation at 4.00 then made a REAL 4.00 return BLOCKED_DUPLICATE.
 *
 * It is the same shape as the incident that produced the escalation-leak fix. That one was "a
 * rolled-back validation must not message a human". This is "a rolled-back validation must not change
 * a later decision". Both come from an effect that runs where a caller cannot un-run it.
 *
 * THE FIX IS A RETURN VALUE, NOT A FLAG
 *
 * A `dryRun: true` parameter would have worked and would have been wrong: it puts the decision about
 * whether to mutate inside the evaluator, where every future caller has to remember to pass it, and
 * where forgetting is silent. Returning the effects instead makes application the CALLER's explicit
 * act. A caller that does nothing with them mutates nothing — which is the correct default for a
 * function whose job is to judge.
 */

import type { Hex } from "viem";
import type { Decision, RecentIntent, SpendIntentInput } from "./types";

/**
 * The duplicate-window record a committed decision adds.
 *
 * It is the whole `RecentIntent` rather than a hash, because the duplicate rule compares whichever
 * tuple `duplicates.keys` names, and a record missing a named field is one the rule cannot compare —
 * which it treats as "not a duplicate", i.e. fails open on the one thing it exists to catch.
 */
export interface DuplicateMarker {
  readonly recentIntent: RecentIntent;
}

/** Rolling-hour rate consumption: one call, at this instant. */
export interface RateConsumption {
  readonly atMs: number;
}

/** Daily budget consumption, in DISPLAY units of the policy's budget token. */
export interface BudgetConsumption {
  readonly dayKey: string;
  readonly amount: number;
}

/** Per-service cooldown clock. Keyed by the endpoint's canonical host, as the cooldown rule reads it. */
export interface CooldownTouch {
  readonly serviceHost: string;
  readonly atMs: number;
}

/** The replay marker: this exact intent hash has now been decided under this partition. */
export interface ReplayMarker {
  readonly intentHash: Hex;
}

/** Enough for a case row to be seeded without the committer having to re-derive it. */
export interface ActivitySeed {
  readonly intentHash: Hex;
  readonly decision: string;
  readonly amount: number;
  readonly recipientAddress: string;
  readonly endpoint: string;
}

/**
 * Everything a decision proposes to change, and nothing it has changed.
 *
 * `null` for a decision that changes nothing — every non-APPROVED outcome. A blocked intent consumed
 * no budget and is not a duplicate anybody should be compared against later, so the honest proposal
 * is the absence of one.
 */
export interface DecisionEffects {
  readonly partitionKey: string;
  readonly duplicate: DuplicateMarker;
  readonly rate: RateConsumption;
  readonly budget: BudgetConsumption;
  readonly cooldown: CooldownTouch;
  readonly replay: ReplayMarker;
  readonly activity: ActivitySeed;
}

/** UTC day bucket (`YYYY-MM-DD`) for the daily-budget window. Shared so two writers cannot disagree. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Derive what an APPROVED decision would change. Pure: same inputs, same proposal, no writes.
 *
 * Returns `null` for anything not APPROVED. The engine only ever committed on APPROVED, and keeping
 * that here rather than at the call site means a future committer cannot accidentally record a
 * blocked intent as a duplicate other requests get measured against.
 */
export function proposeDecisionEffects(args: {
  readonly partitionKey: string;
  readonly intent: SpendIntentInput;
  readonly decision: Decision;
  readonly nowMs: number;
  /** The endpoint's canonical host, computed by the caller that owns URL normalisation. */
  readonly serviceHost: string;
}): DecisionEffects | null {
  if (args.decision.decision !== "APPROVED") return null;

  const { intent, decision, nowMs } = args;
  return {
    partitionKey: args.partitionKey,
    duplicate: {
      recentIntent: {
        intentId: `pi_${decision.intentHash.slice(2, 10)}`,
        taskHash: intent.taskHash,
        endpoint: intent.endpoint,
        paramsHash: intent.paramsHash,
        createdAtMs: nowMs,
        maxAmount: intent.maxAmount.toString(),
        recipientAddress: intent.recipientAddress,
        category: intent.category,
      },
    },
    rate: { atMs: nowMs },
    budget: { dayKey: utcDayKey(nowMs), amount: intent.amount },
    cooldown: { serviceHost: args.serviceHost, atMs: nowMs },
    replay: { intentHash: decision.intentHash },
    activity: {
      intentHash: decision.intentHash,
      decision: decision.decision,
      amount: intent.amount,
      recipientAddress: intent.recipientAddress,
      endpoint: intent.endpoint,
    },
  };
}

/**
 * Build a `BudgetUsage` from its parts, so `effectiveToday` is never computed by hand.
 *
 * It is a derived value — settled plus reserved — and a caller that computed it independently could
 * disagree with the rule that enforces on it. One function, one answer.
 */
export function budgetUsage(settledToday: number, reservedActiveToday: number): {
  readonly settledToday: number;
  readonly reservedActiveToday: number;
  readonly effectiveToday: number;
} {
  return { settledToday, reservedActiveToday, effectiveToday: settledToday + reservedActiveToday };
}
