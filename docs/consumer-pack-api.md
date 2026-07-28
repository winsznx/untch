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

Every provider, its maturity, its capabilities and its **provenance** — a factual record of what was
observed, when. Plus `execution.providersExecutableToday`, derived from durable state, which is empty
today and says so.

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
