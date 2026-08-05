/**
 * What a route is ALLOWED to reach, as a type rather than as a global flag.
 *
 * THE REASONING THIS REPLACES
 *
 * "Is provider execution possible here?" was answered by reading `CONSUMER_EXECUTION_ENABLED`, one
 * process-wide boolean. That is the wrong question asked of the wrong thing. The flag governs whether
 * the Consumer Pack's provider-backed capabilities may run; it says nothing about `/preflight_payment`,
 * which judges a payment and executes nothing. So a deployment that legitimately needs `mail.send`
 * live could not state that its DECISION route was inert — the honest answer was "the flag is on, and
 * separately, that route happens not to call a provider", which is an argument, not a guarantee.
 *
 * An argument stops being true the day somebody adds a dependency. A type does not.
 *
 * HOW THE GUARANTEE IS MADE
 *
 * `DecisionOnlyDeps` cannot NAME an execution dependency, and `assertNoExecutionDependency` below
 * fails `tsc` if one is added. So "the preflight route cannot execute a provider" is checked by the
 * compiler on every build, and no longer depends on the value of an environment variable that another
 * route needs.
 *
 * WHY THE GLOBAL FLAG MAY STAY TRUE
 *
 * Because it is about a different route. `provider_execution` routes read it and must; `decision_only`
 * routes cannot reach an executor whatever it says. Those are separate facts, and conflating them is
 * what forced the choice between "turn off a live capability" and "spend without the guarantee".
 */

import type { PolicyProvider } from "@untch/policy-store";
import type { PerAgentLock } from "@untch/policy-engine";
import type { ScoreDataSource } from "@untch/trust-bureau";
import type { DecisionStateTx } from "@untch/consumer-core";
import type { InMemoryIntentStore } from "./ledger-state";

/**
 * The four things a route can be.
 *
 * A closed set, because an open one becomes "and this route, which is a bit of both". Each value
 * names what the route MAY do; anything absent from that description it may not do.
 */
export const EXECUTION_MANIFEST_ROUTE = "/execution-manifest" as const;

/**
 * Whether an escalated decision can actually reach a human.
 *
 * TRUE, and every word of that is load-bearing.
 *
 * It was false for the right reason: PR #65 moved the account route onto an inline decision
 * transaction wired with `DecisionOnlyDeps`, which correctly cannot name a channel gateway, and in
 * doing so removed the only call site that created an escalation. An `ESCALATED_THRESHOLD` decision
 * persisted evidence and reached nobody, so the honest answer was that nobody would be asked.
 *
 * A constant rather than an environment variable, still, and for the original reason: the value is a
 * property of what is WIRED, not of how an operator configured the process. That is also why flipping
 * it is a reviewed commit rather than a dashboard toggle.
 *
 * WHAT HAD TO BE TRUE BEFORE THIS COULD BE
 *
 *   - the paid lifecycle raises a PROVISIONAL request and activates it only on confirmed settlement
 *   - the delivery worker projects outbox events and sends through the real Discord gateway
 *   - the reconciler reaches the same state from committed data when a process dies
 *   - the action links resolve, and the terminal decision is bound to a nonce, a token and a binding
 *   - a REAL Discord OAuth round trip completes against the registered callback
 *
 * The last one is the one no test could establish. A suite substitutes the code exchange, so it proves
 * the handlers agree with each other and cannot prove Discord accepts the redirect URI. That was
 * settled by a non-financial probe — an OAuth state naming a binding and no action reference — which a
 * person completed against production, matching the subject on the live binding and moving nothing.
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * Not that a provider will run, that a payment will settle, or that anything is delivered. The
 * decision route's dependency type still cannot name an executor, and the per-route manifest below
 * still answers false for all of it. This says one thing: an escalated decision now reaches a human.
 *
 * THE CLOSED BEHAVIOUR IS STILL REACHABLE, AND STILL TESTED
 *
 * `escalationRefusedForUnreadyPath` below takes readiness as an ARGUMENT rather than reading this
 * constant, so both states stay provable in either position. That matters twice: the refusal is what
 * an operator falls back to when this has to be closed, and a behaviour nothing exercises is a
 * behaviour that has quietly stopped working.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RE-CLOSED 2026-08-05, AND THE REASON IS THE ONLY THING THAT MATTERS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The first paid call under activation settled — 0.05 USDT0, transaction
 * `0x2a604ff3acf51fce453844aa6d091abf1f868bdd0b19676901ce00cba32b3db1` — and reached nobody. The
 * service call FINALIZED, the request reached PENDING, the outbox event was written and claimed, and
 * the Discord send returned 404. `DISCORD_SEND_404`, terminal, no message.
 *
 * The cause was a binding whose `channel_chat_id` held the Discord USER id, so the gateway took its
 * guild branch and POSTed to `/channels/<user id>/messages`, which is not a channel. It would have
 * failed identically every time.
 *
 * So the claim this constant makes — an escalated decision reaches a human — was FALSE while it said
 * true, and a person paid for the difference. Everything the activation rested on held except the one
 * link no test covered end to end, which is exactly where it broke.
 *
 * It stays false until the DM path is corrected, the web surface has a real production call site, a
 * non-financial DM actually arrives, and both rollback proofs pass with delivery included.
 */
export const APPROVAL_PATH_READY = false as const;

/**
 * The gate the paid decision route applies to an escalated verdict.
 *
 * A pure function of two facts, so it can be checked in both states without deploying either. When the
 * path is not ready an escalated decision must REFUSE rather than return 200: x402 settles only on a
 * 2xx, so a success here would take the fee for a promise that nobody would be asked.
 */
export function escalationRefusedForUnreadyPath(approvalPathReady: boolean, decision: string): boolean {
  return !approvalPathReady && decision.startsWith("ESCALATED");
}

export type RouteExecutionProfile =
  /** Judges. Reads state, records evidence, moves no money and runs no provider. */
  | "decision_only"
  /** Reads a completed record and reports on it. Writes a verification row and nothing else. */
  | "verification_only"
  /** May call a third-party provider and may settle a payment to one. */
  | "provider_execution"
  /** May run work Untch performs itself, producing artifacts. No third-party provider, no settlement. */
  | "owned_work";

/**
 * Everything `/preflight_payment` needs to reach a decision, and nothing that could act on one.
 *
 * ABSENT BY CONSTRUCTION — each of these is a thing a rollback cannot undo:
 *
 *   provider adapter          — calls somebody else's API
 *   provider execution store  — records that a provider ran
 *   treasury signer           — signs a movement of funds
 *   settlement sender         — broadcasts a payment
 *   delivery executor         — fulfils an order
 *   receipt anchorer          — broadcasts a receipt on chain
 *   channel gateway           — messages a human on Telegram, Discord, Slack or iMessage
 *   work executor             — runs an owned-work service
 *
 * `decisionState` is a transaction-scoped reader/writer of the DECISION window only. It is not an
 * executor: the worst it can do is record that a decision happened, inside the caller's transaction,
 * where a rollback removes it.
 */
export interface DecisionOnlyDeps {
  readonly policyProvider: PolicyProvider;
  /** Resolves a bare `intentHash` from a prior create on this instance. Read-mostly, never executes. */
  readonly intentStore: InMemoryIntentStore;
  /** Injectable clock, so a decision and its evidence agree on when they happened. */
  readonly now?: (() => number) | undefined;
  readonly lock?: PerAgentLock | undefined;
  /** Vendor scores for `vendor.lcbFloor`. A read of a bureau; it moves nothing. */
  readonly scoreDataSource?: ScoreDataSource | null | undefined;
}

/**
 * The names no decision-only dependency bundle may carry.
 *
 * A list of STRINGS used at the type level, so adding an execution dependency is a compile error
 * naming the offending key rather than a runtime surprise in somebody's notifications.
 */
export type ExecutionDependencyName =
  | "providerAdapter"
  | "providers"
  | "providerRegistry"
  | "providerExecutionStore"
  | "executions"
  | "treasurySigner"
  | "treasuryRouter"
  | "settlementSender"
  | "railClient"
  | "deliveryExecutor"
  | "receiptAnchorer"
  | "receiptEnqueuer"
  | "receiptWriter"
  | "channelGateway"
  | "escalationGateway"
  | "workExecutor"
  | "ownedWorkRunner"
  | "oracleSigner"
  | "intentRegistry";

/**
 * THE COMPILE-TIME TEST.
 *
 * Resolves to the offending key names when `T` carries any execution dependency, and to `never` when
 * it carries none. `assertNoExecutionDependency` below only accepts `never`, so adding — say —
 * `escalationGateway` to `DecisionOnlyDeps` turns the build red and prints the key.
 *
 * Deliberately keyed on NAMES rather than on structural shape. A structural check would pass a
 * differently-named field holding the same executor, but the names are the vocabulary this codebase
 * actually uses, and a new executor arriving under a new name is a review-visible event that should
 * add a name here.
 */
export type ExecutionDependenciesIn<T> = Extract<keyof T, ExecutionDependencyName>;

/** Compiles only while `T` has no execution dependency. The argument is the proof. */
export function assertNoExecutionDependency<T>(_witness: ExecutionDependenciesIn<T> extends never ? true : never): void {
  // Nothing to run. The type checker is the assertion; the body would only obscure that.
}

// The assertion itself, evaluated on every `tsc` run of this service.
assertNoExecutionDependency<DecisionOnlyDeps>(true);

/** Every name the runtime guard refuses, as values. Kept beside the type so the two cannot drift. */
export const EXECUTION_DEPENDENCY_NAMES: readonly ExecutionDependencyName[] = Object.freeze([
  "providerAdapter",
  "providers",
  "providerRegistry",
  "providerExecutionStore",
  "executions",
  "treasurySigner",
  "treasuryRouter",
  "settlementSender",
  "railClient",
  "deliveryExecutor",
  "receiptAnchorer",
  "receiptEnqueuer",
  "receiptWriter",
  "channelGateway",
  "escalationGateway",
  "workExecutor",
  "ownedWorkRunner",
  "oracleSigner",
  "intentRegistry",
]);

export class ExecutionDependencyLeakError extends Error {
  constructor(public readonly leaked: readonly string[]) {
    super(
      `a decision_only route was handed execution dependencies it must not be able to reach: ${leaked.join(", ")}. ` +
        "TypeScript narrows what the handler can SEE; it does not stop a wider object being passed, and an " +
        "object carrying an executor is one edit away from a route that uses it.",
    );
    this.name = "ExecutionDependencyLeakError";
  }
}

/**
 * The runtime half of the guarantee.
 *
 * The compile-time assertion proves `DecisionOnlyDeps` cannot NAME an executor. It does not stop a
 * caller passing a wider object that structurally satisfies it — TypeScript permits that for a
 * variable, and the extra keys travel into the function even though the handler cannot read them.
 *
 * So the object is checked too. Narrowing is then something the wiring must actually DO, rather than
 * something the type merely describes.
 */
export function narrowToDecisionOnly<T extends DecisionOnlyDeps>(deps: T): DecisionOnlyDeps {
  const leaked = EXECUTION_DEPENDENCY_NAMES.filter((name) => name in (deps as Record<string, unknown>));
  if (leaked.length > 0) throw new ExecutionDependencyLeakError(leaked);

  const narrowed: DecisionOnlyDeps = {
    policyProvider: deps.policyProvider,
    intentStore: deps.intentStore,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
    ...(deps.scoreDataSource !== undefined ? { scoreDataSource: deps.scoreDataSource } : {}),
  };
  return narrowed;
}

/**
 * What a route publicly promises about its own reach.
 *
 * Returned by the manifest route so the claim is checkable from outside the process, rather than
 * being a sentence in a README that drifts from the wiring.
 */
export interface RouteReachability {
  readonly routeExecutionProfile: RouteExecutionProfile;
  readonly providerExecutionReachable: boolean;
  /** Governed provider payment. NOT the Untch x402 service fee, which is a different economic fact. */
  readonly paymentExecutionReachable: boolean;
  /**
   * DEPRECATED ALIAS for `providerDeliveryExecutionReachable`.
   *
   * Kept because it is already published and a consumer may reasonably read it as permission to
   * perform the purchased service's delivery. It is NOT the OR of provider delivery and approval
   * notification: widening it would turn "we may enqueue a notification" into "we may deliver the
   * thing you bought", which is the opposite of what a reader needs. Removed only in a future
   * versioned manifest.
   */
  readonly deliveryExecutionReachable: boolean;
  /** Delivering the purchased service's output. The precise successor to the alias above. */
  readonly providerDeliveryExecutionReachable: boolean;
  /** Whether this route may write approval state. False until the production writer is wired. */
  readonly approvalStatePersistenceReachable: boolean;
  /** Whether this route may enqueue approval-notification work. Never a direct channel call. */
  readonly approvalNotificationEnqueueReachable: boolean;
  /** Whether this route can reach Telegram, Discord, Slack or web push directly. Always false. */
  readonly directChannelGatewayReachable: boolean;
}

const DECISION_ONLY: RouteReachability = {
  routeExecutionProfile: "decision_only",
  providerExecutionReachable: false,
  paymentExecutionReachable: false,
  deliveryExecutionReachable: false,
  providerDeliveryExecutionReachable: false,
  // Both read the flag rather than restating it, so the manifest and the gate cannot disagree. Tables
  // existing is not the same as a path being wired, and advertising persistence because a table exists
  // is how "LIVE" got into the README.
  approvalStatePersistenceReachable: APPROVAL_PATH_READY,
  approvalNotificationEnqueueReachable: APPROVAL_PATH_READY,
  /**
   * Still false, and it is not an oversight.
   *
   * The route ENQUEUES; it does not send. The outbox row is written inside the decision transaction and
   * the Discord call happens later, in the worker, after that transaction has committed. So a rolled
   * back decision messages nobody — which is a property of this being false rather than a caveat on it.
   */
  directChannelGatewayReachable: false,
};

const VERIFICATION_ONLY: RouteReachability = {
  routeExecutionProfile: "verification_only",
  providerExecutionReachable: false,
  paymentExecutionReachable: false,
  deliveryExecutionReachable: false,
  providerDeliveryExecutionReachable: false,
  approvalStatePersistenceReachable: false,
  approvalNotificationEnqueueReachable: false,
  directChannelGatewayReachable: false,
};

const PROVIDER_EXECUTION: RouteReachability = {
  routeExecutionProfile: "provider_execution",
  providerExecutionReachable: true,
  paymentExecutionReachable: true,
  deliveryExecutionReachable: true,
  providerDeliveryExecutionReachable: true,
  approvalStatePersistenceReachable: false,
  approvalNotificationEnqueueReachable: false,
  // The legacy escalation gateway still serves the older protocol route, and that is a direct call.
  directChannelGatewayReachable: true,
};

/**
 * Owned work runs a service Untch performs ITSELF and produces artifacts.
 *
 * No third-party provider and no settlement to one — Untch is the worker. `deliveryExecutionReachable`
 * is true because it does deliver something: files, with a manifest. Saying otherwise would be the
 * comfortable answer rather than the accurate one.
 */
const OWNED_WORK: RouteReachability = {
  routeExecutionProfile: "owned_work",
  providerExecutionReachable: false,
  paymentExecutionReachable: false,
  deliveryExecutionReachable: true,
  providerDeliveryExecutionReachable: true,
  approvalStatePersistenceReachable: false,
  approvalNotificationEnqueueReachable: false,
  directChannelGatewayReachable: false,
};

/**
 * Every route that has a profile, and what it promises.
 *
 * A route absent from this table has not been classified, which the manifest reports as exactly that
 * rather than defaulting it to the safest-sounding value. An unclassified route is a gap somebody
 * should close, and a default would hide it.
 */
export const ROUTE_EXECUTION_MANIFEST: Readonly<Record<string, RouteReachability>> = Object.freeze({
  "/preflight_payment": DECISION_ONLY,
  "/internal/consumer/preflight-validate": DECISION_ONLY,
  "/verify_delivery": VERIFICATION_ONLY,
  "/consumer/intents": PROVIDER_EXECUTION,
  "/consumer/fund/:intentId": PROVIDER_EXECUTION,
  "/consumer/execute": PROVIDER_EXECUTION,
  "/owned/demo": OWNED_WORK,
  "/owned/battle-card": OWNED_WORK,
});

export function routeReachability(route: string): RouteReachability | null {
  return ROUTE_EXECUTION_MANIFEST[route] ?? null;
}

/**
 * The manifest as served.
 *
 * `globalProviderExecutionEnabled` is reported BESIDE the per-route answers, not instead of them.
 * A reader has to be able to see that the global switch is on and that the decision route still
 * cannot reach an executor — that separation is the whole point, and hiding the flag would look like
 * an answer that had been arranged.
 */
export function executionManifest(globalProviderExecutionEnabled: boolean): Record<string, unknown> {
  return {
    globalProviderExecutionEnabled,
    approvalPathReady: APPROVAL_PATH_READY,
    note:
      "Per-route reachability is a property of the dependency types each route is wired with, not of " +
      "the global flag. A decision_only route cannot reach a provider, a settlement sender or a " +
      "channel gateway even while the global flag is true, because its dependency type cannot name one.",
    deprecations: {
      deliveryExecutionReachable:
        "Deprecated alias for providerDeliveryExecutionReachable. It means the purchased service's " +
        "OWN delivery and nothing else. It is deliberately NOT the OR of provider delivery and " +
        "approval-notification delivery, because a consumer may read it as permission to deliver what " +
        "was bought. Removed only in a future versioned manifest.",
    },
    routes: ROUTE_EXECUTION_MANIFEST,
  };
}
