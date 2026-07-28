# Consumer Pack — pre-activation cold audit

**Ran:** 2026-07-27, against `feat/consumer-pack` @ `27c9231`, before any real funds moved.
**Method:** 7 independent adversarial reviewers, one per dimension, each told to assume the author
was competent but wrong somewhere and to report only defects with a `file:line` and a concrete
failure scenario. Each dimension's most severe claim was then attacked by a separate skeptic
instructed to default to "refuted" when uncertain. 14 agents, ~1.6M tokens.
**Fixes committed in:** `15ad090`.

The headline: **the audit found more than the build did, and several findings sat directly in the
path of the first live payment.** Two would have made it fail outright; one would have corrupted the
ledger *after* the merchant was paid.

---

## Disposition summary

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | `X-PAYMENT` is the x402 **v1** header; v2 is `PAYMENT-SIGNATURE` | P0 | **Fixed** — sends v2 + v1 alias |
| 2 | Payment envelope missing `resource`/`extensions`, extra top-level keys | P1 | **Fixed** — aligned to the reference client |
| 3 | `pay()` re-selected the option independently → decoy attack | P1 | **Fixed** — one selector, test added |
| 4 | `readSettlementTx` ignored `success`/`errorReason` | P1 | **Fixed** — a failed settlement now throws |
| 5 | Zero-value ledger legs violate `CHECK (amount <> 0)` after payment | P1 | **Fixed** — zero legs omitted |
| 6 | SETTLEMENT booked to a treasury id nothing reads → daily cap dead | P1 | **Fixed** — resolves the registered account |
| 7 | Discovery capability used a synthetic intent id → FK violation | P1 | **Fixed** — real id + retire after use |
| 8 | `status`/`payment`/`delivery`/`receipt`/SSE not tenant-scoped | P0 | **Fixed** — `policyId` required, scoped reads |
| 9 | SSE subscriber leaks if the client aborts during replay | P1 | **Fixed** — close handler before the await |
| 10 | The four required feature flags did not exist | P1 | **Fixed** — added, fail-closed, execution off by default |
| 11 | Boot re-seed reverts maturity and re-enables a disabled provider | P1 | **Fixed** — seed introduces, operator owns state |
| 12 | `shop.*`/`travel.*` stamped `.quote` → zero fee, wrong exec capability | P1 | **Fixed** — stamped with the ultimate action |
| 13 | Funding handler fabricates an `unsettled:` tx hash | P0 | **Fixed** — pending marker, `finalized: false` |
| 14 | Cross-rail clearing account documented but never written | P1 | **Accepted, documented** — see below |
| 15 | `assertIntentSettled` never called in production | P2 | **Accepted** — see below |
| 16 | Concurrent funding POSTs: second settles on-chain, is discarded | P1 | **Mitigated + documented** — see below |
| 17 | No sweeper for `PROVIDER_PAID`/`PROVIDER_ACKNOWLEDGED` crash states | P1 | **Accepted, documented** — see below |
| 18 | `claimIdempotency` is dead code; create is find-then-insert | P1 | **Accepted** — the unique index still holds |
| 19 | `accountDaySpend` clock differs between memory and pg stores | P2 | **Accepted, documented** |
| 20 | `validBefore` provider-controlled and unbounded | P1 | **Mitigated** — capped, see below |
| 21 | Operator treasury/provider screens have no auth | P1 | **Open** — see below |

---

## The three that would have broken the first live payment

### 1. Wrong payment header (P0)

`X-PAYMENT` is x402 **v1**. Version 2 names it `PAYMENT-SIGNATURE`.

Confirmed three independent ways rather than taken on the reviewer's word:
- `@okxweb3/x402-fetch`'s compiled client emits `PAYMENT-SIGNATURE`;
- Untch's own first settled payment (`internal/day0/D0.1-evidence/paid-call-transcript.json`) shows
  the `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` pair;
- a live probe against `stabledomains.dev` with a deliberately-invalid signature.

The probe partially **refuted** the reviewer's claim in a useful way: StableDomains' facilitator
accepts *both* names, returning `invalid_exact_evm_payload_signature` under each. So this specific
provider would have worked. A different facilitator would not have. Fixed by sending the v2 name with
the v1 alias — belt and braces, at no cost.

That probe also produced the single most valuable signal in the whole audit: reaching
`invalid_exact_evm_payload_signature` means the envelope **parsed** and the requirements **matched**
at a real facilitator. Only the signature (deliberately garbage) failed.

### 2. Zero-value ledger legs (P1)

`recognitionGroup` emitted explicit zero rows for a zero fee and a zero spread — my own choice, for
audit readability. `consumer_ledger_entries` carries `CHECK (amount <> 0)`.

`domains.check` has no `FEE_BPS` entry, so its fee is zero. **This is the exact action chosen for the
first live run.** The sequence would have been: pay the merchant $0.05 → verify delivery → write
RECOGNITION → `SQLSTATE 23514` → transaction rolls back → intent stranded in `DELIVERY_VERIFIED`
with the obligation permanently open and every retry failing identically.

It passed all 587 tests because `InMemoryConsumerStore` has no such constraint — precisely the
"one of the two lied" divergence the in-memory store's own header warns about.

### 3. Tenant isolation on reads (P0)

`GET /consumer/intent/:id` fell back to an unscoped read when `policyId` was omitted, and
`/payment`, `/delivery`, `/receipt` and the SSE stream never scoped at all. Anyone holding an intent
id could read another tenant's amounts, provider, policy decision and full receipt, or stream its
lifecycle in real time.

Fixed: `policyId` is now required on every read and all of them go through `getIntentForTenant`.

**Residual risk, stated plainly:** `policyId` is a public on-chain value, so presenting it is
*scoping*, not *proof of ownership*. A caller who knows both a policy id and an intent id can still
read that intent. Closing this properly needs the SIWE session the dashboard already uses, extended
to the A2MCP surface. Recorded as an open risk, not silently assumed away.

---

## Accepted, with reasons

### 14. Cross-rail clearing account never written

Real. `ledger.ts` documents `CROSS_RAIL_CLEARING` as the join between the two halves of a cross-rail
movement, and nothing writes it. The consequence is that a completed cross-rail intent expenses the
goods twice — once as `COST_OF_GOODS` on the funding rail, once as `PROVIDER_SETTLEMENT` on the
settlement rail — and the settlement float's ledger position drifts monotonically negative.

**Not fixed here, deliberately.** The correct fix changes what a completed intent's books look like,
and doing that in the same change as the first live settlement would mean the run proves a ledger
shape that is about to be replaced. The first live action is single-rail in economic substance (a
$0.05 read settled on Base with no user-funding leg), so the double-expensing path is not exercised
by it. Filed as the top ledger item for the next change.

### 15. `assertIntentSettled` never called in production

Real, and my own comment in `complete()` overstated it. It is asserted in the test suite and in the
demo, not in the orchestrator. Also passes vacuously when the obligation account is absent.

Left as-is for this activation because calling it inside `complete()` would make a ledger assertion
failure abort a completed purchase — worse behaviour than the gap. It belongs in the reconciler,
where a failure is an alert rather than a rollback.

### 16. Concurrent funding POSTs

Two simultaneous funding requests both settle on-chain; `recordFunding` accepts the first and
silently discards the second, so the payer is out of pocket with nothing recorded. The window is
narrow (both must pass the `DynamicPrice` check before either commits) and the discarded payment is
recoverable from chain evidence.

Mitigated by `finalized: false` and the pending-hash marker (finding 13), which means the
reconciler can now see that a funding row's hash was never resolved. A proper fix needs the price
function and the receipt insert to share a lock. Documented in the runbook.

### 17. Missing sweepers for post-payment crash states

`startConsumerWorkers` sweeps `EXECUTION_QUEUED`, `PROVIDER_ACKNOWLEDGED` and `DELIVERY_PENDING`. A
crash inside `executeIntent` between the state change and the response leaves an intent in
`PROVIDER_PAYMENT_PENDING` or `PROVIDER_PAID` with nothing to pick it up.

`reconcileAmbiguous` handles `PROVIDER_PAYMENT_PENDING` via the execution row, which is written
before the request leaves — so the evidence exists even though the sweep is incomplete. Documented;
the missing sweep is a follow-up.

### 20. Unbounded `validBefore`

`validBefore = now + max(60, maxTimeoutSeconds)` and `maxTimeoutSeconds` comes from the provider. A
hostile provider could request a very long window, leaving a signed bearer authorization valid for
years, and N of them could jointly exceed the float.

Partially mitigated: the capability is single-use and short-lived, so only one authorization per
intent can be produced. The provider-controlled ceiling is real and is now bounded — see the
follow-up list. Every provider observed sends `300`.

### 21. Operator screens without auth

`/dashboard/consumer/treasury` and `/dashboard/consumer/providers` read globally without checking
the session, exposing float addresses, balances and limits to any visitor. Addresses are shortened
and no key is exposed, but balances and limits should not be public.

**Open.** Must be fixed before the dashboard is publicly reachable with the Consumer Pack enabled.

---

## What the audit refuted

Worth recording, because a padded audit is as costly as a thin one.

- **Treasury account-id mismatch in `assertWithinLimits`** — I suspected this independently and
  checked it first. `TREASURY:${assetKey}:${treasuryRef}` matches `ledger.ts`'s `accountIdFor`
  exactly. Not a defect. (The *related* finding 6 — the orchestrator passing a derived ref rather
  than the registered one — was real, and is a different bug at a different site.)
- **`X-PAYMENT` universally ignored** — refuted by live probe; the target provider accepts both.
- **`express.json` ordering breaks the funding handler** — refuted; the handler does not read the
  body, and route registration happens after body parsing.
- **A slow SSE client blocks the dispatcher** — refuted; `res.write` is non-blocking. Unbounded
  buffering is real but is a memory concern, not a stall.

---

## Verification after fixes

```
589 tests pass, 0 fail   (canon 55, policy 60, proof 18, asp 122, receipt-writer 14,
                          escalation 88, trust-bureau 28, web 33, gov-watch 11,
                          consumer-core 95, consumer-providers 65)
typecheck root  clean    (excluding scripts/demo-video, untracked + gitignored, pre-existing)
typecheck asp   clean
typecheck web   clean
migration 007   verified against the REAL production schema in a rolled-back transaction:
                21 tables, 11 money-guarantee indexes, append-only RULEs proven behaviourally,
                tenant isolation proven, existing data (20 receipts / 16 policies / 19 ledger
                entries / 12 escalations) untouched, nothing persisted
```

New regression tests added for the fixes: the decoy-option attack, and a fully verified/funded/
approved intent still refusing when `CONSUMER_EXECUTION_ENABLED` is off.
