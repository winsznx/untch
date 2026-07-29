# Consumer Pack API

The wire contract. Every route is under the existing Untch ASP (`https://asp.untch.xyz`).

Errors use the house §11 envelope: `{ code, message, retryable, docsUrl }`.

## Two prices, always

- **Fixed route price** — Untch's orchestration fee, settled by the OKX x402 rail on X Layer.
- **Variable purchase value** — funded separately at `POST /consumer/fund/:intentId`.

A 402 on a *route* is the call fee. A 402 on the *funding* route is the purchase.

---

## Untch Shop

### `POST /consumer/shop/search` — $0.02
```json
{ "policyId": "42", "query": "wireless headphones", "priceMax": 80, "limit": 10 }
```
→ `200` with `intentId`, `state`, `providerId`, `options[]`
(`{ ref, title, description, indicativePrice, imageUrl, attributes }`), `statusUrl`, `eventsUrl`.

`indicativePrice` is `null` by design on providers that do not price a search. Nothing binds until a
quote is produced from the merchant's own price challenge.

### `POST /consumer/shop/quote` — $0.05
```json
{ "policyId": "42", "ref": "B0CXYZ1234", "email": "…", "shippingAddress": { … } }
```
→ `200` with `quote`, `decision`, `nextAction`, and — when the policy approves — `fundingRequest`.

`nextAction` is `FUND`, `AWAIT_APPROVAL` or `NONE`.

### `POST /consumer/shop/purchase` — $0.05
```json
{ "policyId": "42", "intentId": "ci_…" }
```
→ **`202`** with the current state and `nextAction`. Execution is queued; this request does not wait
for it.

### `GET /consumer/shop/order/:intentId` — free

---

## Untch Domains

`POST /consumer/domains/check` ($0.02) · `POST /consumer/domains/quote` ($0.05) ·
`POST /consumer/domains/register` ($0.05) · `POST /consumer/domains/renew` ($0.05) ·
`GET /consumer/domains/status/:intentId` (free)

```json
{ "policyId": "42", "ref": "example.xyz" }
```

The quote's `terms` carry `readyToRegister` and `profileNote`. StableDomains requires a verified ICANN
registrant profile before `/api/register` will succeed, so `register` **refuses before spending** when
it is unmet — $20 must not be spent on a call the provider will reject.

---

## Untch Travel

`POST /consumer/travel/search` ($0.03) · `POST /consumer/travel/compare` ($0.02) ·
`POST /consumer/travel/quote` ($0.05) · `POST /consumer/travel/book` ($0.05) ·
`GET /consumer/travel/booking/:intentId` (free)

```json
{ "policyId": "42", "origin": "SFO", "destination": "JFK",
  "departureDate": "2026-09-15", "adults": 1 }
```

`quote` and `book` currently return **`501 CAPABILITY_UNAVAILABLE`**. No integrated provider sells
travel inventory: StableTravel's own live guidance states it "does not issue tickets, hold
reservations, or take payment for travel". The routes exist as typed contracts so a booking provider
can fill the capability without an API change — they do not pretend to book.

---

## Untch Gifts

`POST /consumer/gifts/quote` ($0.05) · `POST /consumer/gifts/order` ($0.05) ·
`GET /consumer/gifts/status/:intentId` (free)

---

## Untch Consumer Notify

`POST /consumer/notify/{confirmation,receipt,exception}` — $0.03 each.

```json
{ "policyId": "42", "to": ["buyer@example.com"], "subject": "Your order",
  "text": "…", "replyTo": "…" }
```

The audit trail records a **subject hash** and a recipient **count** — never the body, never the
recipient list.

`notify.*` is Untch mailing *you* about *your* intent. If you want to buy an email action as the
product, that is Untch Mail below — a different family, a different policy category, and a different
blast radius.

---

## Untch Mail

Eight tools over StableEmail. Every paid route **quotes**; none of them settles inline.
`POST /consumer/mail/execute` is the one door that spends, and it takes an intent that has already
been quoted, policy-checked and funded.

| Route | Fee | Provider price | Tool state |
| --- | --- | --- | --- |
| `POST /consumer/mail/send` | $0.05 | $0.02 | **LIVE** |
| `POST /consumer/mail/inbox/buy` | $0.05 | $1.00 / 30 days | **LIVE** |
| `POST /consumer/mail/inbox/messages` | $0.02 | $0.001 | **LIVE** |
| `POST /consumer/mail/inbox/topup` | $0.05 | $1.00 / $2.50 / $8.00 | BETA |
| `POST /consumer/mail/subdomain/buy` | $0.05 | $5.00 | BETA |
| `POST /consumer/mail/inbox/status` | $0.02 | free | PARTNER_ACCESS_REQUIRED |
| `POST /consumer/mail/inbox/cancel` | $0.05 | free | PARTNER_ACCESS_REQUIRED |
| `POST /consumer/mail/subdomain/status` | $0.02 | free | PARTNER_ACCESS_REQUIRED |
| `POST /consumer/mail/subdomain/send` | $0.05 | $0.005 | PARTNER_ACCESS_REQUIRED |
| `POST /consumer/mail/execute` | $0.05 | | |

The provider price is never read from that table at runtime. It is read from StableEmail's own 402,
seconds before you are asked to approve it, so an approval binds to the merchant's figure.

```json
{ "policyId": "42", "to": ["buyer@example.com"], "subject": "Your order", "text": "…" }
```

`mail.inbox.topup` takes `"period": "month" | "quarter" | "year"`, which selects the provider's own
endpoint rather than computing a discount.

**What a Mail receipt knows.** A recipient count, a subject hash, a body hash, and — after
execution — a message-id hash. Never the address, never the subject, never the body. The body hash
binds the exact bytes, so a body cannot be swapped between approval and execution while the subject
stays the same.

**What Untch will not claim.** A send to the open internet cannot be verified from the sender side.
StableEmail's shared relay exposes no per-message status endpoint, so `mail.send` delivery evidence
is `untchVerified: false, method: NONE`, and the receipt says so. An **inbox** purchase *is*
verifiable: Untch pays to read the inbox back, and being admitted as the payer is itself the
ownership proof.

**Why four tools say PARTNER_ACCESS_REQUIRED.** Three are SIWX-gated and owner-scoped. StableEmail
authorises them by owner *signature*, and the wallet that owns Untch's inbox is the Base settlement
treasury. Satisfying that would mean giving the SIWX identity key the treasury's key, turning a
powerless identity into a spending key so that a leaked signer could drain the float. Untch will not
make that trade for a status field, so those tools stay blocked by choice. `mail.subdomain.send`
needs a subdomain Untch does not own.

`mail.inbox.messages` reads the same inbox by *payer*, which the treasury already is. That is the
route Untch uses, and it is what makes `mail.send` delivery verifiable: an inbox Untch owns can be
read back, where the open internet cannot. It returns hashes only, because StableEmail cannot tell
one Untch caller from another and raw senders or subjects would let any caller read the operational
mailbox by naming it.

---

## Untch Consumer Status (all free)

`GET /consumer/intent/:intentId` — state, amounts, provider, policy, URLs.

`GET /consumer/intent/:intentId/payment` — `userFunding` and `providerSettlement` as two separate
facts, each with its own chain and transaction.

`GET /consumer/intent/:intentId/delivery` —
```json
{ "providerAttested": { "status": "active", "reference": "ord_1", … },
  "untchVerified": { "verified": true, "method": "DNS_LOOKUP", "detail": "…" } }
```
Never merged. `providerAttested` is the merchant's claim; `untchVerified` is what Untch independently
confirmed.

`GET /consumer/intent/:intentId/receipt` — the full cross-rail receipt: user funding, provider
settlement, fee, spread, policy + decision, approval + who resolved it, delivery evidence, the ledger
groups, `quoteHash`, `spendIntentHash`, and an integrity digest.

`GET /consumer/intent/:intentId/events` — **SSE**.
```
id: 7
event: consumer.provider.paid
data: {"intentId":"ci_…","seq":7,"name":"consumer.provider.paid", …}
```
Send `Last-Event-ID` to resume; the server replays from the durable record before attaching to the
live stream, so the sequence is gapless. Heartbeats are comment frames. Polling
`GET /consumer/intent/:intentId` is the fallback.

---

## The funding leg

### `POST /consumer/fund/:intentId` — **dynamic price**

Unpaid, this 402s with the intent's **exact authorised amount** in X Layer USDT0. Pay it with any
x402 client; the paid retry records the settlement and queues execution.

Refuses (never falls back to a default price) when the intent is unknown, not in `AWAITING_FUNDING`,
already funded, past its funding window, or its quote has expired.

→ `200 { intentId, state, funded, settlementTx, statusUrl, eventsUrl }`

---

## `GET /consumer/catalog` — free

Every provider, its capabilities and its **provenance** — a factual record of what was observed,
when. Plus `execution.providersExecutableToday`, derived from durable state.

Each capability carries a `state`, which is the honest answer per **tool**, not per provider:

| `state` | Means |
| --- | --- |
| `LIVE` | A real settled payment from an Untch treasury was observed **and** the delivery was verified. The only state that executes on production. |
| `BETA` | Implemented and validated against the live contract. Nothing has settled yet. |
| `SANDBOX` | Reachable, but a leg is unproven — and the work to prove it is ours. |
| `PARTNER_ACCESS_REQUIRED` | Blocked by something outside Untch: a partner agreement, an identity we do not hold, a rail we cannot sign for, or an operation the provider does not offer. `accessBlocker` names which. |
| `DISABLED` | Not integrated, or switched off. Cannot be selected at all. |

The state is derived from the internal maturity ladder by a pure function, so the catalog, the
dashboard and the OKX.AI registration draft cannot drift from each other or from the execution gate.
It only ever downgrades: a stale blocker can never mute a capability that has settled and verified,
and nothing in the gate reads the label — so it cannot be edited into permission.

One provider routinely shows several states at once. StableEmail is `LIVE` for `mail.send`, `BETA`
for `mail.inbox.buy`, and `PARTNER_ACCESS_REQUIRED` for `mail.inbox.status`. That is the point.

---

## Typical flow

```
POST /consumer/domains/quote      → intentId, quote, decision, fundingRequest   ($0.05 fee)
POST /consumer/fund/:intentId     → 402 for $20.40, pay, 200                    (purchase value)
GET  /consumer/intent/:id/events  → …funding.confirmed → provider.paid → completed
GET  /consumer/intent/:id/receipt → the full cross-rail receipt
```

If the policy escalates, the quote returns `nextAction: "AWAIT_APPROVAL"` instead, and the stream
emits `consumer.approval.required` then `consumer.approval.completed`. Untch never auto-approves: an
escalation nobody answers is a withheld spend, not a granted one.

---

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `CONSUMER_PACK_NOT_CONFIGURED` | 503 | no `DATABASE_URL` on this instance |
| `CAPABILITY_UNAVAILABLE` | 501 | no enabled provider declares this capability |
| `PROVIDER_NOT_EXECUTABLE` | 503 | below the required maturity |
| `TREASURY_INSUFFICIENT` | 503 | no rail key, or the float would drop below its floor |
| `PAUSED` | 503 | a kill switch is engaged |
| `QUOTE_EXPIRED` | 409 | the quote's TTL lapsed |
| `PROVIDER_UNAUTHORIZED` | 403 | SIWX missing, or the approval no longer binds |
| `PROVIDER_BAD_REQUEST` | 400 | malformed input |
| `PROVIDER_RATE_LIMITED` | 429 | retry after the given delay |
| `PAYMENT_CHALLENGE_UNACCEPTABLE` | 502 | wrong chain, token, recipient or amount |
| `PAYMENT_AMBIGUOUS` | 502 | outcome unknown — **never retryable**, goes to manual review |
| `PROTOCOL_NOT_EXECUTABLE` | 502 | the rail is parsed but cannot be settled in this build |
