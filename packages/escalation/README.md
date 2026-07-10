# @untch/escalation — the operator-approval path (PRD §7.2 / §27)

When the deterministic policy engine escalates a spend instead of approving or blocking it, **this
service carries the decision to a human and carries the human's answer back — without ever letting the
channel decide.** It owns the §7.2 escalation lifecycle and the §27 authority-boundary check, exposes a
channel-agnostic seam (Telegram now, Photon later), and wires x402-guard's `poll()` so an `ESCALATED`
decision resolves for real once the operator responds.

```
Policy decides → channel notifies & captures → THIS service validates → guard sees the resolved state
```

---

## The core property this service guarantees (treat with I1/I2/I4 rigor)

**Channels never make money decisions. They only transport an operator's response to an escalation the
policy engine already created.**

Every incoming approval — from any channel — is IGNORED unless, at the instant it arrives, it passes the
FULL §27 authority-boundary check:

| # | §27 check | Enforced in `handleInbound` | Failure ⇒ |
|---|-----------|------------------------------|-----------|
| 1 | intent still active | escalation not past `code_expires_at` (fail-closed derived expiry) | `IGNORED_EXPIRED` |
| 2 | policy allows escalation | the escalation exists only for an `ESCALATED_*` decision, and the channel ∈ `policy.approvals.channels` | `IGNORED_UNBOUND` |
| 3 | sender's binding matches | the binding tuple (interim: bound Telegram chat id) | `IGNORED_UNBOUND` |
| 4 | single-use code valid & unexpired & unredeemed | constant-time sha256 compare; a same-channel replay is a reused code | `IGNORED_BAD_CODE` |
| 5 | channel caps respected | `amount ≤ policy.approvals.channelCaps[channel]` | `IGNORED_CHANNEL_CAP` |
| 6 | dual-channel rule satisfied | `amount > dualChannelAbove` ⇒ two DISTINCT channels required | held at `AWAITING_SECOND_CHANNEL` |
| 7 | Vault/Broker-Guard re-validates | out of this service's scope — the settlement path independently re-checks nonce/expiry/policy/amount/recipient | — |

**Any failure — even a plausible-looking approval from an unbound sender, a replayed code, or an expired
code — is ignored and receipted as a failed control event (`onFailedControlEvent`), never silently
accepted, never silently dropped.** This is tested as an explicit adversarial property, not assumed:
see [`test/service.test.ts`](test/service.test.ts) (`ADVERSARIAL wrong sender`, `ADVERSARIAL replayed
code`, `ADVERSARIAL expired code`, plus wrong-channel, bad-code, and channel-cap cases).

---

## The §7.2 state machine

```
CREATED ─▶ FAN_OUT (to the policy's channels ∩ the registered channels)
 │           each escalation carries a single-use code, TTL = escalation timeout
 ├─ all channels fail ─▶ NOTIFY_FAILED (inbox-visible; the timeout clock still runs)
 ├─ APPROVE (passes the FULL §27 check) ─▶ APPROVED           (or AWAITING_SECOND_CHANNEL if dual required)
 ├─ DENY    (passes the FULL §27 check) ─▶ DENIED
 ├─ invalid / unbound / replayed / capped ─▶ IGNORED_* (logged; escalation stays PENDING)
 └─ timeout T ─▶ EXPIRED ─▶ default DENY (I2 — fail closed, same as everywhere else)
Idempotent across channels: the first valid decision wins; the rest are acked as already-resolved.
```

`status ∈ PENDING | AWAITING_SECOND_CHANNEL | APPROVED | DENIED | EXPIRED | NOTIFY_FAILED` — exactly the
§8 `escalations` shape ([`migrations/003_escalations.sql`](migrations/003_escalations.sql)).

**Fail-closed timeout (I2).** The timeout fires via a BullMQ delayed job on the shared Redis, but the
default-DENY does not depend on Redis: an open escalation past its `code_expires_at` reads as `EXPIRED`
(→ DENIED) on any inbound or any guard `poll()`, and a periodic `sweepExpired` backstops a lost job. The
money can never sit held forever, and it can never settle after the deadline.

---

## Wiring x402-guard's `poll()` (task 5)

The guard, on an `ESCALATED` preflight decision, returns a non-blocking poll handle whose id is
`receiptRef.receiptId ?? intentHash` — the same value this service stores as `poll_ref`.
`makeEscalationResolver(service)` bridges the two:

```ts
import { EscalationService, makeEscalationResolver } from "@untch/escalation";

const outcome = await guardedBuyerCall({
  /* … */,
  escalationResolver: makeEscalationResolver(service), // poll() now resolves against THIS service
});
// outcome.status === "ESCALATED" → outcome.pollHandle.poll() reflects PENDING → APPROVED / DENIED for real
```

This replaces the stub/injected resolver the guard was polling against. An operator's Telegram tap that
passes the §27 check flips `poll()` to `APPROVED`; a timeout defaults it to `DENIED`. The channel never
reaches the guard — only the resolved state does.

---

## The channel-agnostic seam

A `Channel` does exactly two transport things and nothing else — `send` an escalation carrying the code,
and `startReceiving` inbound responses normalized to a transport-neutral `InboundResponse`. The service
runs every response through the same §27 check regardless of origin. Implementing a new channel is
implementing that one interface; **the core state machine does not change.**

### Deliberate scope limits — documented, not silent gaps

**1. Photon is NOT built here (the D0.6 gate has never run).**
[§29 D0.6](../../internal/untch-prd.md) — subscription confirmed live, a real echo, a poll-vote
roundtrip — has no PASS evidence. Building the escalation service against Photon now would repeat the
mistake of building on an unvalidated external dependency. So the Photon channel is deferred: this ships
a **clean `Channel` interface Photon (Spectrum) implements later** without touching the core. **Next
step: run D0.6, then add a `PhotonChannel implements Channel`.** Until then, Telegram is the one real
implementation.

**2. Dual-channel enforcement is correct but currently inert.**
`policy.approvals.dualChannelAbove` is implemented at the logic level (`AWAITING_SECOND_CHANNEL` requires
a second **distinct** channel — see the passing `dual-channel` tests). But with only Telegram live there
is no second channel to satisfy it, so above-threshold amounts stay `AWAITING_SECOND_CHANNEL` until they
time out to DENY. This is **correct once Photon (or the dashboard channel) exists** — we did not fake a
second channel to make it "work." Below the threshold, a single Telegram approval resolves normally.

**3. Handle-binding is an interim env binding.**
There is no onboarding/binding UI yet (no dashboard exists), so the real §27 binding tuple (channel +
provider + spaceId/conversation + sender handle + verified operator wallet + last-verified-at, set by a
code roundtrip) is not yet capturable. The interim is a single configured **`TELEGRAM_CHAT_ID` bound to
the same demo operator this whole build has used** (the Step-5 demo wallet), clearly labeled temporary —
the same pattern as the demo wallet elsewhere. **Real requirement (named future step): a proper
onboarding/binding flow, presumably via the eventual dashboard (§15).** The check is strict: only the
exact bound chat id on the `telegram` channel counts; any other sender is `IGNORED_UNBOUND`.

---

## Run it

Uses the **same shared Postgres + Redis** the receipt writer and policy store use — no new instance.

```bash
# apply migration 003_escalations.sql to the shared Postgres
pnpm --filter @untch/escalation migrate

# the timeout worker — fires §7.2 timeout → EXPIRED → default DENY (BullMQ on the shared Redis) + a
# 30s safety sweep as a backstop for any lost job
pnpm --filter @untch/escalation timeout-worker

# the Telegram receiver — long-polls the bot and runs every inbound through the §27 authority boundary
pnpm --filter @untch/escalation telegram-receiver
```

### The real end-to-end proof (task 6)

```bash
pnpm --filter @untch/asp escalation:e2e
```

Drives one real cycle: a real over-threshold intent → real paid `preflight_payment` → `ESCALATED` →
real Telegram message with APPROVE/DENY buttons → **operator taps APPROVE** → §27 check → the guard's
`poll()` reflects `APPROVED` for real. It needs the real secrets (`BUYER_PRIVATE_KEY`, `PAY_TO_ADDRESS`,
`DEMO_POLICY_ID`/`HASH`, `DATABASE_URL`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) and a
human tap; missing any prints a precise PREREQ report and exits non-zero — **it never fabricates a
PASS.** `TELEGRAM_*` is the D0.7 gate; until that runs, this is the ready harness and the adversarial
offline battery is the correctness proof.

---

## Tests

```bash
pnpm --filter @untch/escalation test        # 32 tests: state machine + adversarial authority boundary
```

Covers every §7.2 transition, the three named adversarial cases (wrong sender, replayed code, expired
code) plus wrong-channel / bad-code / channel-cap, the dual-channel logic (with a synthetic second
channel to prove correctness — the live system has only Telegram), timeout → default DENY, the
fail-closed derived-expiry, the not-found path, Telegram callback/text parsing + send, and the code
hashing (single-use, constant-time). The in-memory repo mirrors the Postgres repo's compare-and-set
transition semantics, so "first valid decision wins" is exercised against the same guard the database
enforces.

---

## Data model

`escalations` (§8): `id`, `intent_id`, `poll_ref` (the guard's poll key), `status`, `reason`,
`policy_id`, `amount`, `token`, `approvals` (the §27 config snapshotted at creation), `approval_code_hash`
(sha256 only — the plaintext code is never stored), `code_expires_at`, `channel_log` (append-only
fan-out + inbound audit trail, including every IGNORED_* failed control event), `approved_channels` (for
dual-channel), `resolved_by`, `resolved_at`. Postgres is the source of truth; Redis carries only the
timeout signal.
