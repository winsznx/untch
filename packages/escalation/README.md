# @untch/escalation — the operator-approval path (PRD §7.2 / §27)

When the deterministic policy engine escalates a spend instead of approving or blocking it, **this
service carries the decision to a human and carries the human's answer back — without ever letting the
channel decide.** It owns the §7.2 escalation lifecycle and the §27 authority-boundary check, exposes a
channel-agnostic seam (three real channels today: **Telegram, Discord, and Slack**; Photon later), and
wires x402-guard's `poll()` so an `ESCALATED` decision resolves for real once the operator responds.

One operator, three reachable surfaces — not three approvers. Each channel binds to the SAME operator
identity through its own handle (Telegram chat id, Discord user id, Slack user id); any bound channel can
approve that operator's escalations, and an amount above `dualChannelAbove` requires two DISTINCT ones.

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
implementing that one interface; **the core state machine does not change.** Discord and Slack are the
proof: each is one `implements Channel` file, and neither touched a line of the state machine or the §27
check.

### The three real channels + their transport choices

| Channel | Send | Receive | Why this receive path |
|---------|------|---------|-----------------------|
| **Telegram** | Bot API `sendMessage` (inline buttons) | long-poll `getUpdates` | no public endpoint; outbound only |
| **Discord** | REST `POST /users/@me/channels` → DM with buttons | **gateway** (WebSocket) | interactions-webhook needs a PUBLIC endpoint + Ed25519 signature checks — a new inbound attack surface; the gateway is outbound-only, matching Telegram |
| **Slack** | `conversations.open` → `chat.postMessage` (Block Kit buttons) | **Socket Mode** (WebSocket) | the Events API needs a public endpoint + signing-secret verification; Socket Mode opens an outbound socket from an app-level token, no public endpoint |

Both new channels are **DM to one bound operator** (never a public server/team channel — a broadcast
surface has a different trust model than a private DM to a single bound identity), both carry the code in
the same `a:<escId>:<code>` button payload and accept the same `APPROVE <code>` text baseline, and both
use Node's built-in `WebSocket` (Node 22+) rather than a heavy client SDK — so, like Telegram, they are
unit-tested with an injected socket and no network. See
[`src/discord.ts`](src/discord.ts) and [`src/slack.ts`](src/slack.ts) for the full choice rationale.

### Deliberate scope limits — documented, not silent gaps

**1. Photon is NOT built here (the D0.6 gate has never run).**
[§29 D0.6](../../internal/untch-prd.md) — subscription confirmed live, a real echo, a poll-vote
roundtrip — has no PASS evidence. Building the escalation service against Photon now would repeat the
mistake of building on an unvalidated external dependency. So the Photon channel is deferred: this ships
a **clean `Channel` interface Photon (Spectrum) implements later** without touching the core. **Next
step: run D0.6, then add a `PhotonChannel implements Channel`.** Telegram, Discord, and Slack are the
real implementations today; Photon is the one deferred channel, pending its own D0.6 validation.

**2. Dual-channel enforcement is genuinely proven — no longer inert.**
`policy.approvals.dualChannelAbove` requires a second **distinct** channel (`AWAITING_SECOND_CHANNEL` →
`APPROVED`). Step 7 shipped this logic but noted it as inert, because with only Telegram live there was no
second channel to satisfy it. That is no longer true: with three real channels, the rule is enforced for
real. [`test/dual-channel.test.ts`](test/dual-channel.test.ts) proves both directions against the same
compare-and-set repo semantics Postgres enforces —
  * **positive:** an above-threshold escalation approved on one channel (e.g. telegram) holds at
    `AWAITING_SECOND_CHANNEL`, and a tap on a DISTINCT channel (e.g. discord) transitions it to
    `APPROVED`;
  * **negative:** the SAME channel approving twice (a second tap or a retry) is rejected as a reused code
    (`IGNORED_BAD_CODE`) and never counts as the distinct second channel — it stays held.

Below the threshold, a single bound channel approves normally.

**3. Handle-binding is an interim env binding — for all three channels.**
There is no onboarding/binding UI yet (no dashboard exists), so the real §27 binding tuple (channel +
provider + spaceId/conversation + sender handle + verified operator wallet + last-verified-at, set by a
code roundtrip) is not yet capturable. The interim is one configured id per channel, all bound to the
**same demo operator this whole build has used** (the Step-5 demo wallet): `TELEGRAM_CHAT_ID`,
`DISCORD_USER_ID`, `SLACK_USER_ID`. This is the "one operator, three surfaces" model — combined with
`combineBindings`, a bound approval on ANY channel authorizes the operator, while any other sender on any
channel is `IGNORED_UNBOUND`. Clearly labeled temporary. **Real requirement (named future step): a proper
onboarding/binding flow, presumably via the eventual dashboard (§15).**

**Schema-readiness for multiple operators is in place ([`migrations/004_operators.sql`](migrations/004_operators.sql)),
but no logic reads it yet.** The live binding above is still the env-derived `combineBindings`. In parallel,
three tables persist the operator identity so a second approver later is an INSERT, not a migration:
`escalation_operators` (the identity), `escalation_operator_bindings` (the `(channel, handle) → operator`
map — the persisted form of the env bindings), and `policy_approvers(policy_id, operator_id)` (which
operators may approve a policy). They are provisioned with exactly today's one operator: its channel
handles at boot, a `policy_approvers` row per policy when it escalates. This is deliberately readiness
only — nothing consults these tables for authority until the §15 flow wires them.

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

The **deployed seller** wires every configured channel automatically: on boot it registers Telegram,
Discord, and/or Slack (whichever env is set), binds them all to the same operator via `combineBindings`,
starts each receiver, and fans an escalation out across all of them (∩ `policy.approvals.channels`). No
channel is faked — one that isn't configured simply isn't registered.

### The real end-to-end proofs (task 5)

```bash
pnpm --filter @untch/asp escalation:e2e            # Telegram, in-process service (D0.7)
pnpm --filter @untch/asp escalation:live           # Telegram, through the live public endpoint (D0.7)
pnpm --filter @untch/asp escalation:proof discord  # Discord solo, through the live public endpoint
pnpm --filter @untch/asp escalation:proof slack    # Slack solo, through the live public endpoint
pnpm --filter @untch/asp escalation:proof dual     # two DISTINCT channels resolve one above-threshold escalation
```

Each drives one real cycle: a real over-threshold intent → real paid `preflight_payment` → `ESCALATED`
→ real DM(s) with Approve/Deny buttons → **operator taps Approve** → §27 check → the guard's `poll()`
reflects `APPROVED` for real. The channel proofs run entirely through the deployed seller's public
endpoints and confirm the result INDEPENDENTLY by reading the escalation record's own `status`,
`approved_channels`, and `channel_log` off `GET /escalation_status/:pollRef` — never by trusting the
script's own success message.

The buyer side needs only `BUYER_PRIVATE_KEY` + `PAY_TO_ADDRESS`. Everything channel-side (bot tokens,
the bound operator ids, Postgres, Redis, the §27 check) is the **seller's**. If the deployed seller has
not been configured for the target channel (`DISCORD_*` / `SLACK_*`), the driver prints a precise PREREQ
report and exits non-zero — **it never fabricates a PASS.** This is the exact honest boundary the
Telegram e2e held before its D0.7 token was live: the adversarial offline battery below is the standing
correctness proof; each live proof is the one real human tap on top of it.

---

## Tests

```bash
pnpm --filter @untch/escalation test        # 56 tests: state machine + adversarial boundary + all 3 channels
```

Covers every §7.2 transition; the three named adversarial cases (wrong sender, replayed code, expired
code) run against Telegram AND across Discord and Slack; wrong-channel / bad-code / channel-cap; the
**dual-channel rule proven with three real channels** — positive (two distinct channels → APPROVED) and
negative (same channel twice → `IGNORED_BAD_CODE`, still held); timeout → default DENY; the fail-closed
derived-expiry; the not-found path; each channel's send + pure event→`InboundResponse` normalizer + its
gateway/socket lifecycle (identify, heartbeat, ack, reconnect/backoff) driven by an injected fake
WebSocket with no network; and the code hashing (single-use, constant-time). The in-memory repo mirrors
the Postgres repo's compare-and-set transition semantics, so "first valid decision wins" and the
dual-channel distinctness check are exercised against the same guard the database enforces.

---

## Data model

`escalations` (§8): `id`, `intent_id`, `poll_ref` (the guard's poll key), `status`, `reason`,
`policy_id`, `amount`, `token`, `approvals` (the §27 config snapshotted at creation), `approval_code_hash`
(sha256 only — the plaintext code is never stored), `code_expires_at`, `channel_log` (append-only
fan-out + inbound audit trail, including every IGNORED_* failed control event), `approved_channels` (for
dual-channel), `resolved_by`, `resolved_at`. Postgres is the source of truth; Redis carries only the
timeout signal.
