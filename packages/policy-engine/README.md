# @untch/policy-engine

Deterministic preflight policy engine (PRD §7.1). Given a bounded `SpendIntent`, an active-policy
record, and a ledger snapshot, it returns an approve/block decision plus a machine-readable rule
trace — with **no LLM anywhere** (invariant I1) and **fail-closed** behavior throughout (invariant
I2: any missing or malformed input yields a `BLOCKED_*` / `REJECTED_*` outcome, never a silent
`APPROVE`).

> **This is a PARTIAL implementation — a slice of the full §7.1 engine, not the whole thing.**
> **Ten of §7.1's thirteen `RULE_EVAL` rules are real**, in their exact §7.1 order, alongside the
> `policy.active` lookup and the per-agent concurrency lock that makes budget checks race-safe:
> `duplicate`, `cooldown`, `recipient` allow/deny, `worker-agent` allow/deny, `category` allow/deny,
> `intent-bound` (amount vs the intent's own `maxAmount`), `per-call cap`, `budget.daily`,
> `rate limit`, and `escalate-above`. **Three `RULE_EVAL` rules remain STUBBED**: each returns
> `PASS` yet is tagged `implemented: false` in the decision trace, so it is never silently skipped
> and never silently passed. The three are stubbed on purpose — each needs a subsystem this package
> does not have yet: `replay/context-binding` needs the §14 x402 challenge envelope, `vendor LCB
> floor` needs the §12 Trust Bureau, and `proof-tier requirement` needs the §13 Proof Engine's tier
> concept. Implementing them now would mean guessing interfaces we'd likely redo. A manifest test
> (`test/manifest.test.ts`) pins exactly which rules are real (10) and which are stubbed (3), so
> nobody mistakes this slice for the complete engine. The full chain is specified in **PRD §7.1**.

## What's real vs stubbed

Rules are listed in §7.1 `RULE_EVAL` order (the order the trace shows). `policy.active` is the
POLICY_LOOKUP that precedes `RULE_EVAL`.

| Rule (trace name) | Status | §7.1 terminal code |
|---|---|---|
| `policy.active` | **real** | `BLOCKED_NO_ACTIVE_POLICY` |
| `duplicate.taskHash_endpoint_paramsHash` | **real** | `BLOCKED_DUPLICATE` |
| `cooldown.sameService` | **real** | `BLOCKED_COOLDOWN` |
| `replay.contextBinding` | stub | `BLOCKED_REPLAY` (needs §14 challenge envelope) |
| `recipient.allowDeny` | **real** | `BLOCKED_RECIPIENT` |
| `agent.workerAllowDeny` | **real** | `BLOCKED_AGENT` |
| `category.allow` | **real** | `BLOCKED_CATEGORY` |
| `vendor.lcbFloor` | stub | `BLOCKED_VENDOR_RISK` / `ESCALATED_VENDOR_RISK` (needs §12 Trust Bureau) |
| `intent.maxAmountBound` | **real** | `BLOCKED_INTENT_BOUND` |
| `perCall.cap` | **real** | `BLOCKED_PER_CALL_CAP` / `ESCALATED_PER_CALL_CAP` (per policy) |
| `budget.daily` | **real** | `BLOCKED_BUDGET` |
| `rate.limit` | **real** | `BLOCKED_RATE` |
| `proof.tierRequired` | stub | `ESCALATED_PROOF_TIER` (needs §13 Proof Engine tiers) |
| `escalate.aboveThreshold` | **real** | `ESCALATED_THRESHOLD` |
| per-agent concurrency lock | **real** (in-memory) | serializes intents, no budget race |

The terminal codes this slice can emit are `REJECTED_MALFORMED`, `BLOCKED_NO_ACTIVE_POLICY`,
`BLOCKED_FAIL_CLOSED`, `BLOCKED_DUPLICATE`, `BLOCKED_COOLDOWN`, `BLOCKED_RECIPIENT`, `BLOCKED_AGENT`,
`BLOCKED_CATEGORY`, `BLOCKED_INTENT_BOUND`, `BLOCKED_PER_CALL_CAP`, `ESCALATED_PER_CALL_CAP`,
`BLOCKED_BUDGET`, `BLOCKED_RATE`, `ESCALATED_THRESHOLD`, and `APPROVED` — this is the first slice
that produces the `ESCALATED_*` family. An `ESCALATED_*` outcome withholds the spend (it routes to
the approval pipeline, §7.2); it is not an approval. `BLOCKED_REPLAY`, the vendor-risk codes, and
`ESCALATED_PROOF_TIER` arrive with their still-stubbed rules.

### Two policy fields added beyond §8's JSON

§8's `policies.rules` JSON did not literally carry every field §7.1's rules need, so two were added
(same naming convention as the surrounding §8 fields):

- **`recipients: {allow, deny}`** — §8 has category/vendor/agent allow-deny lists but no
  recipient-address list, though §7.1 requires one. Added with the `{allow, deny}` shape (holding
  addresses) that `categories` already uses.
- **`onPerCallCapExceeded: "ESCALATE" | "BLOCK"`** — §8 has `perCallCap` but no ESCALATE-vs-BLOCK
  selector, though §7.1 makes per-call-cap resolution "per policy". Added mirroring
  `vendors.onBelowFloor`; optional, defaults to `"BLOCK"` (conservative) when absent.

## Design notes

- **Reuses `@untch/canon` (D0.5) — never reimplements hashing/canonicalization.** The `intentHash`
  is `@untch/canon`'s `hashSpendIntent` over the §8.1 struct; addresses, uint256 fields, and the
  endpoint URL are validated/normalized with canon's `canonAddress` / `canonUint256` / `canonUrl`.
- **No infrastructure.** The engine takes ledger state as an injected argument (`LedgerWindowState`
  — `spentTodayByAgent`, `recentIntents`, `lastCallByService` for cooldown, `callsInLastHour` for
  the rate limit), so it runs with zero external services. The caller supplies real data later;
  the package still tests with nothing running. Real Postgres/Redis wiring is a later step.
- **Decision trace matches PRD §8.2.** The `Decision` object carries `decision`, `intentHash`,
  `policyId`, `policyVersion`, `evaluatedAt`, and `rules[]` exactly as §8.2 shows (plus an additive
  `reasons[]`), so a later receipt writer consumes it unchanged.
- **The concurrency lock is real, not a stub.** `evaluateIntentSerialized` acquires a per-`agentId`
  in-memory async mutex around the read → evaluate → commit critical section. In-memory is correct
  for a single process; the production upgrade is a distributed (Redis) lock, per §7.1, with the
  on-chain vault epoch accounting (§7.5) as the backstop. See `src/concurrency.ts`.

## API

```ts
import { evaluateIntent, evaluateIntentSerialized, PerAgentLock } from "@untch/policy-engine";

// Pure, synchronous, no I/O — ledger state injected:
const decision = evaluateIntent(intent, policy, ledgerWindowState);

// Race-safe: serializes concurrent intents for the same agent behind a per-agentId lock:
const decision = await evaluateIntentSerialized(intent, policy, ledger /* read + commitApproved */);
```

## Test & build

```sh
pnpm --filter @untch/policy-engine typecheck   # tsc --noEmit
pnpm test:policy                               # node --import tsx --test (from repo root)
```

The suite covers every terminal state, the §8.2 trace shape, and the rule manifest. Each of the
ten implemented rules has a block/escalate case and a pass case (`test/rules.test.ts`), plus
order-correctness tests that give an intent two violations and assert the trace fails on the
**earlier** §7.1 rule (proving short-circuit order, not just "a" failure). The load-bearing
concurrency test asserts the budget race: the **same** two-intent scenario **double-approves
without the lock** (proving the test is real) and yields **exactly one `APPROVED` + one
`BLOCKED_BUDGET` with the lock**.
