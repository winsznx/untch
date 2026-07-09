# @untch/policy-engine

Deterministic preflight policy engine (PRD §7.1). Given a bounded `SpendIntent`, an active-policy
record, and a ledger snapshot, it returns an approve/block decision plus a machine-readable rule
trace — with **no LLM anywhere** (invariant I1) and **fail-closed** behavior throughout (invariant
I2: any missing or malformed input yields a `BLOCKED_*` / `REJECTED_*` outcome, never a silent
`APPROVE`).

> **This is a PARTIAL implementation — an early slice of the full §7.1 engine, not the whole
> thing.** Only three rules are real: the `policy.active` lookup, the `duplicate` check, and the
> `budget.daily` check — plus the per-agent concurrency lock that makes budget checks race-safe.
> **Every other §7.1 `RULE_EVAL` rule is present but STUBBED**: it returns `PASS` yet is tagged
> `implemented: false` in the decision trace, so it is never silently skipped and never silently
> passed. A manifest test (`test/manifest.test.ts`) pins exactly which rules are real and which are
> stubbed, so nobody mistakes this slice for the complete engine. The full rule chain — replay /
> context binding, recipient allow/deny, worker-agent allow/deny, category, vendor LCB floor,
> intent max-amount bound, per-call cap, cooldown, rate limit, proof-tier requirement, and the
> escalate-above-threshold and vendor-risk escalation paths — is specified in **PRD §7.1**.

## What's real vs stubbed

| Rule (trace name) | Status | §7.1 terminal code |
|---|---|---|
| `policy.active` | **real** | `BLOCKED_NO_ACTIVE_POLICY` |
| `duplicate.taskHash_endpoint_paramsHash` | **real** | `BLOCKED_DUPLICATE` |
| `budget.daily` | **real** | `BLOCKED_BUDGET` |
| per-agent concurrency lock | **real** (in-memory) | serializes intents, no budget race |
| `cooldown.sameService` | stub | `BLOCKED_COOLDOWN` |
| `replay.contextBinding` | stub | `BLOCKED_REPLAY` (Challenge Binding Check, §14) |
| `recipient.allowDeny` | stub | `BLOCKED_RECIPIENT` |
| `agent.workerAllowDeny` | stub | `BLOCKED_AGENT` |
| `category.allow` | stub | `BLOCKED_CATEGORY` |
| `vendor.lcbFloor` | stub | `BLOCKED_VENDOR_RISK` / `ESCALATED_VENDOR_RISK` |
| `intent.maxAmountBound` | stub | `BLOCKED_INTENT_BOUND` |
| `perCall.cap` | stub | `ESCALATED` / `BLOCKED` |
| `rate.limit` | stub | `BLOCKED_RATE` |
| `proof.tierRequired` | stub | `ESCALATED_PROOF_TIER` |
| `escalate.aboveThreshold` | stub | `ESCALATED_THRESHOLD` |

The terminal codes this slice can actually emit are `REJECTED_MALFORMED`,
`BLOCKED_NO_ACTIVE_POLICY`, `BLOCKED_FAIL_CLOSED`, `BLOCKED_DUPLICATE`, `BLOCKED_BUDGET`, and
`APPROVED`. The `ESCALATED_*` family and the other `BLOCKED_*` codes arrive with their real rules.

## Design notes

- **Reuses `@untch/canon` (D0.5) — never reimplements hashing/canonicalization.** The `intentHash`
  is `@untch/canon`'s `hashSpendIntent` over the §8.1 struct; addresses, uint256 fields, and the
  endpoint URL are validated/normalized with canon's `canonAddress` / `canonUint256` / `canonUrl`.
- **No infrastructure.** The engine takes ledger state as an injected argument
  (`LedgerWindowState` — `spentTodayByAgent`, `recentIntents`), so it runs with zero external
  services. Real Postgres/Redis wiring is a later step.
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

The suite covers every terminal state, the §8.2 trace shape, the rule manifest, and — the
load-bearing one — the budget race: it asserts the **same** two-intent scenario **double-approves
without the lock** (proving the test is real) and yields **exactly one `APPROVED` + one
`BLOCKED_BUDGET` with the lock**.
