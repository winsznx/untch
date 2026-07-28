# Consumer Intent lifecycle

One durable record per real-world action, advanced through 22 states by exactly one authority.

## The rules that make it safe

**One validator.** `assertTransition(from, to)` in `packages/consumer-core/src/state.ts` checks every
edge against a frozen adjacency map. Nothing else judges a transition.

**One mutator.** `ConsumerStore.transition(intentId, expectedFrom, to, patch, event)` is the only way
`state` changes. It is a compare-and-set — `UPDATE … WHERE intent_id = $1 AND state = $2` — and it
writes the outbox event in the same unit of work. There is no `setState`, no `save(intent)`, and no
way to emit an event without a transition or to transition without an event. Two workers racing the
same intent produce one winner and one `StaleIntentStateError`.

**No controller or adapter touches state.** The orchestrator is the only caller.

## The happy path

```
CREATED → DISCOVERING → QUOTED → POLICY_CHECKING → APPROVED
        → AWAITING_FUNDING → FUNDED → EXECUTION_QUEUED
        → PROVIDER_PAYMENT_PENDING → PROVIDER_PAID → PROVIDER_ACKNOWLEDGED
        → DELIVERY_PENDING → DELIVERY_VERIFIED → COMPLETED
```

With a human in the loop, `POLICY_CHECKING → AWAITING_APPROVAL → APPROVED`.

## The properties, and why each exists

These are asserted as **properties over the whole transition map**, not spot-checked, so an edge
added next year cannot violate them (`packages/consumer-core/test/state.test.ts`).

### FAILED_BEFORE_PAYMENT is unreachable from every post-payment state

Directly and transitively. `POST_PAYMENT_STATES` starts at `PROVIDER_PAYMENT_PENDING` — deliberately,
because "the request is in flight and its outcome is unknown" is exactly the case where assuming no
money moved is the dangerous assumption. A lifecycle that could still claim "failed before payment"
from there would let a refund be issued for a purchase that actually happened.

### MANUAL_REVIEW can never re-arm the executor

A human may settle an ambiguous outcome — `COMPLETED`, `REFUND_PENDING`, `REFUNDED`,
`FAILED_AFTER_PAYMENT`, `CANCELLED`. A human may **not** push it back to `EXECUTION_QUEUED` or
`PROVIDER_PAYMENT_PENDING`, because the executor would happily pay a second time.

### An ambiguous in-flight payment has exactly three exits

`PROVIDER_PAID`, `FAILED_AFTER_PAYMENT`, or `MANUAL_REVIEW`. Never a retry.

### The only backward edge is FUNDED → AWAITING_FUNDING

A chain reorg can un-settle a funding payment. It is legal precisely because nothing has been spent
yet. Every other edge moves forward.

### Terminal means terminal

`COMPLETED`, `BLOCKED`, `REFUNDED`, `EXPIRED`, `CANCELLED` have no successors. Every non-terminal
state has at least one, so nothing is a dead end. No state transitions to itself.

### Every block follows an attempted check

`QUOTED → BLOCKED` is **not** legal. A missing policy still moves through `POLICY_CHECKING` on its
way to `BLOCKED`, so "blocked" always means "we looked". (This was a real bug caught by the suite
during the build: the orchestrator tried to jump straight to `BLOCKED` when a policy was missing, and
the state machine refused it.)

### Only pre-execution states expire

`EXPIRABLE_STATES` stops at `AWAITING_FUNDING`. Once execution is armed, a timeout is an operational
event for the worker, never a silent expiry that could race a payment already in flight. Every
expirable state can actually reach `EXPIRED` — also asserted.

## Failure paths

**Before payment** → `FAILED_BEFORE_PAYMENT` → `REFUND_PENDING` → `REFUNDED`. The user's funding is
recoverable in full; a `REFUND` ledger group converts the obligation into a payable.

**After payment, outcome known** → `FAILED_AFTER_PAYMENT`.

**After payment, outcome unknown** → `MANUAL_REVIEW`, with the funding parked in a `SUSPENSE` ledger
account. The discriminator is `NormalizedProviderError.sideEffectPossible`, not an HTTP status.

`retryable && sideEffectPossible` is a contradiction and is **rejected at construction**
(`errors.ts`): if a side effect might have occurred, resending is not a retry, it is a possible
double purchase.

## Where each transition happens

| Method | Edge |
|---|---|
| `createIntent` | → `CREATED` |
| `discover` | → `DISCOVERING` |
| `quote` | → `QUOTED` |
| `runPolicy` | → `POLICY_CHECKING` → `APPROVED` \| `AWAITING_APPROVAL` \| `BLOCKED` |
| `resolveApproval` | `AWAITING_APPROVAL` → `APPROVED` \| `BLOCKED` |
| `requestFunding` | → `AWAITING_FUNDING` |
| `confirmFunding` | → `FUNDED` |
| `queueExecution` | → `EXECUTION_QUEUED` |
| `executeIntent` | → `PROVIDER_PAYMENT_PENDING` → `PROVIDER_PAID` → `PROVIDER_ACKNOWLEDGED` |
| `verifyAndComplete` | → `DELIVERY_PENDING` → `DELIVERY_VERIFIED` → `COMPLETED` |
| `expireStale` | → `EXPIRED` |
| `reconcileAmbiguous` | → `MANUAL_REVIEW` |

## The ordering inside executeIntent

This is the safety property of the whole pack:

1. **Gates** — quote freshness, approval still binds, provider executable, circuit closed.
2. **Capability** — the treasury mints a single-use, narrowly-scoped authority.
3. **State → `PROVIDER_PAYMENT_PENDING`** — the point of no return.
4. **Execution row written** — before the request leaves, so a process that dies leaves evidence.
5. **Request sent.**

Everything before step 3 can fail into `FAILED_BEFORE_PAYMENT` and refund. Everything after cannot,
because the state machine forbids that edge.

## Events

The outbox writes the event in the same transaction as the state change, with a per-intent monotonic
`seq`. That is what makes `Last-Event-ID` resume exact rather than best-effort: a client that
disconnects and reconnects replays from the durable record and sees the identical sequence a
connected client saw.

`consumer.intent.created` · `consumer.discovery.completed` · `consumer.quote.created` ·
`consumer.policy.approved` · `consumer.policy.blocked` · `consumer.approval.required` ·
`consumer.approval.completed` · `consumer.funding.requested` · `consumer.funding.confirmed` ·
`consumer.execution.started` · `consumer.provider.paid` · `consumer.provider.acknowledged` ·
`consumer.delivery.verified` · `consumer.completed` · `consumer.failed` ·
`consumer.refund.pending` · `consumer.refunded` · `consumer.manual_review.required`
