# OKX.AI re-registration package — Untch ASP, eight services

**Date:** 2026-07-27
**Identity:** existing **Untch** ASP — ERC-8004 agent **6047**, marketplace ASP **6086**.
No new listing, no second identity, no new review cycle for the ASP itself.

This supersedes `internal/okx-consumer-pack-listing-draft.md` on one material point: since that draft
was written, `stabledomains × domains.check` has been **promoted to verified on real settlement
evidence**, so the Consumer Pack now has one capability that has genuinely moved money and can be
registered as executing rather than as quoting.

Everything in this document was read off the **live production endpoint** at the timestamps below,
not from source. Where something is not true yet it says so, in the row, without softening.

---

## 0. What changed since the last submission

| Change | Why a reviewer should care |
|---|---|
| `domains.check` promoted to **verified** on a real settled payment | The listing can now say a Consumer Pack capability executes, with a transaction to check |
| **Public receipt** endpoint + page shipped | A reviewer can open a receipt for a real purchase without an account |
| **Ownership proof (SIWE)** on tenant-scoped reads | Previously `?policyId=` — a public on-chain identifier — was the only scope. That was namespacing, not authorisation |
| **Cross-rail ledger** corrected | A cross-rail purchase was expensed on both rails; the settlement float read as unexplained drift |
| Two ungated operator pages closed | Treasury addresses/balances and provider provenance were readable by any visitor |

---

## 1. The eight services

Five are already registered and unchanged. Three are the Consumer Pack additions.

### Already registered — verify unchanged, do not re-submit

| # | Service | Method + path | Price | Live 402 verified |
|---|---|---|---|---|
| 1 | `ping_untch` | `GET /ping_untch` | $0.01 | ✅ v2, `resource=https://asp.untch.xyz/ping_untch` |
| 2 | `preflight_payment` | `POST /preflight_payment` | $0.05 | ✅ v2, https resource |
| 3 | `verify_delivery` | `POST /verify_delivery` | $0.10 | ✅ v2, https resource |
| 4 | `score_vendor` / `score_buyer` | `POST /score_vendor`, `POST /score_buyer` | $0.20 each | ✅ v2, https resource |
| 5 | `generate_dispute_packet` / `reconcile_agent_spend` | `POST /generate_dispute_packet`, `POST /reconcile_agent_spend` | $0.50 / $0.25 | ✅ v2, https resource |

All settle **USDT0 on X Layer (`eip155:196`)** to
`0xD9eD4D474B0D01031d10d637546450F39ed6a5ba`.

> The x402 v2 challenge is carried in the **`payment-required` response header** (base64 JSON), not
> in the body — the body is `{}`. A reviewer testing with a v1 client that only reads the body will
> see an empty 402 and conclude the service is broken. It is not; it is v2.

### New — Consumer Pack

| # | Service | Register now? | What is actually true |
|---|---|---|---|
| 6 | **Untch Consumer Status** | **Yes** | Free, read-only. No provider dependency. Now includes the public receipt. |
| 7 | **Untch Domains** | **Yes — check + quote** | `domains.check` is **verified and has settled real USDC**. `register`/`renew` remain `sandbox`. |
| 8 | **Untch Travel** | **Yes — search + compare only** | Live fares via StableTravel, provider maturity `sandbox`, so nothing executes. |

**Not registered, and why** — registering a service whose execute route returns
`PROVIDER_NOT_EXECUTABLE` would be a listing that takes a fee and cannot deliver:

| Held back | Blocker (live maturity) |
|---|---|
| Untch Shop | `purch` = `experimental`. Settles only on Solana; that rail is not executable in this build. |
| Untch Gifts | `stablemerch` = `experimental`. SIWX identity leg unproven against their verifier. |
| Untch Consumer Notify | `stableemail` = `sandbox`. Needs one verified settlement. |
| Untch Domains *register/renew* | capability = `sandbox`. Only `domains.check` has settled. |

Live maturity, read from `/consumer/catalog` on 2026-07-27:

```
purch          provider=experimental  shop.*=experimental
stabledomains  provider=verified      domains.check=verified  domains.quote=sandbox
                                      domains.register=sandbox  domains.renew=sandbox  domains.dns=experimental
stableemail    provider=sandbox       notify.*=sandbox
stablemerch    provider=experimental  gifts.*=experimental
stabletravel   provider=sandbox       travel.search=sandbox  travel.compare=sandbox

execution.providersExecutableToday = ["stabledomains"]
execution.sandboxExecutionAllowed  = false
```

`effectiveMaturity` takes the **minimum** of provider and capability, so promoting the provider to
`verified` did not promote its other capabilities. That is why `domains.register` still cannot
execute even though `stabledomains` is verified.

---

## 2. Service 6 — Untch Consumer Status

**Type:** A2MCP · **Price:** free
**Primary endpoint:** `GET https://asp.untch.xyz/consumer/intent/{intentId}`

> Track any governed consumer action Untch is running for you: current state, what the user funded,
> what the merchant was paid, the delivery evidence, and the final cross-rail receipt. A live event
> stream with `Last-Event-ID` resume lets an agent watch a purchase without polling. Every completed
> action also has a public receipt anyone can open.

| Route | Auth | Notes |
|---|---|---|
| `GET /consumer/intent/{id}` | scoped | state, quote, funding, decision |
| `GET /consumer/intent/{id}/payment` | scoped | funding + settlement legs |
| `GET /consumer/intent/{id}/delivery` | scoped | merchant claim and Untch's check, **separately** |
| `GET /consumer/intent/{id}/receipt` | scoped | full private receipt incl. ledger groups |
| `GET /consumer/intent/{id}/events` | scoped (`?token=`) | SSE, resumable |
| `GET /consumer/receipt/{id}` | **public** | shareable receipt — see §4 |

### Curl a reviewer can run

```bash
# Public receipt for a REAL completed purchase. No account, no key.
curl -s https://asp.untch.xyz/consumer/receipt/ci_50a37ce77505690e8b45df13 | jq

# The same thing as a page.
open https://untch.xyz/receipt/ci_50a37ce77505690e8b45df13
```

Live response (abridged, 2026-07-27):

```json
{
  "action": "domains.check",
  "state": "COMPLETED",
  "settlement": {
    "providerId": "stabledomains",
    "amount": { "display": "0.050000", "token": "USDC", "chain": "eip155:8453" },
    "recipient": "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
    "txHash": "0xe7ce102f7a704e9c3113fc7fcc8626db8a9cdc330e614d023c231e88fce21e86"
  },
  "delivery": { "providerAttested": "available", "untchVerified": true, "method": "HTTP_PROBE" },
  "policy": { "policyId": "9001", "decision": "APPROVED" },
  "receipt": { "state": "NOT_RECORDED", "reason": "…" }
}
```

That `txHash` is a real Base mainnet transaction in block 49196541. It is checkable on Basescan.

---

## 3. Service 7 — Untch Domains

**Type:** A2MCP · **Price:** $0.02 check · $0.05 quote
**Endpoint:** `POST https://asp.untch.xyz/consumer/domains/check`

> Check a domain across 28 TLDs and get a bindable registration quote — the registrar's own exact
> price, plus Untch's disclosed fee and cross-rail spread, with a TTL. Every quote runs through a
> deterministic spend policy before anything can be funded, and the check itself is paid for on the
> registrar's own rail under a capped, single-use payment authorisation.

**What may now be claimed that could not be before:** the check leg *executes*. Untch paid
StableDomains 0.050000 USDC on Base from its own settlement float, under an EIP-3009 authorisation
scoped to one amount and one recipient, and then verified the answer against **public RDAP** rather
than against the merchant's own assertion.

**What still may not be claimed:** registration. `domains.register` and `domains.renew` are
`sandbox`; the routes exist as typed contracts and refuse with a named reason.

---

## 4. Service 8 — Untch Travel

**Type:** A2MCP · **Price:** $0.03 search · $0.02 compare
**Endpoint:** `POST https://asp.untch.xyz/consumer/travel/search`

> Live cash fares with price insights, and the airline and OTA links that actually book them —
> governed, budgeted and receipted.

**Say "search and compare". Never "book".** The integrated provider states it "does not issue
tickets, hold reservations, or take payment for travel". `/consumer/travel/book` returns
`501 CAPABILITY_UNAVAILABLE`.

---

## 5. The public receipt — what a reviewer should test

New since the last submission, and the fastest way to check Untch is not asserting things it cannot
show.

```bash
curl -s https://asp.untch.xyz/consumer/receipt/ci_50a37ce77505690e8b45df13 | jq '.receipt, .delivery'
```

The `receipt` field is one of five states, and they are deliberately distinguishable:

| State | Meaning |
|---|---|
| `NOT_RECORDED` | Completed, but no §7.4 receipt was written. Carries the reason. |
| `PENDING` | Durable and queued for the next anchor batch. Nothing is wrong. |
| `ANCHORED` | On chain, with `txHash` and `blockNumber`. |
| `ANCHOR_FAILED` | The writer gave up. **The payment and delivery facts are unaffected.** |
| `NOT_FOUND` | The intent names a receipt that does not exist — an inconsistency, not a wait state. |

The example intent above currently reads `NOT_RECORDED`, and that is the honest answer: it was
executed by the live smoke driver, which passed no receipt writer. The production ASP has the writer
wired; the next execution through the production path records one. **This is stated rather than
hidden** — a reviewer who sees `NOT_RECORDED` is seeing the system report its own gap.

**The public view withholds** the request payload, the correlation id and which operator channel
resolved an approval. Verified live: the stored request `{"domain":"untchactivation3ni92u.xyz"}` and
correlation id `smoke-ms3ni92u` appear in **neither** the API response nor the rendered page.

---

## 6. Authentication — what needs it, what does not

New since the last submission. Previously a tenant-scoped read was scoped by `?policyId=`, and a
policy id is public on-chain data — so any caller who read one off the explorer could read that
tenant's intents. That is now closed.

**Public, no auth:**
`/consumer/catalog` · `/consumer/receipt/{id}` · `/consumer/auth/nonce` · `/consumer/auth/verify`

**Scoped, needs a session:** the nine routes listed in `catalog.auth.scopedRoutes`.

```bash
# 1. Get a server-issued, single-use, expiring nonce
curl -s -X POST https://asp.untch.xyz/consumer/auth/nonce \
  -H 'content-type: application/json' -d '{}' | jq

# 2. Sign a SIWE message naming: this domain, that nonce, an X Layer chainId (196 or 195),
#    and `untch:policy:<policyId>` in Resources. The signer must be the policy's ON-CHAIN OWNER.
# 3. Exchange it for a 30-minute bearer
curl -s -X POST https://asp.untch.xyz/consumer/auth/verify \
  -H 'content-type: application/json' -d '{"message":"...","signature":"0x..."}' | jq
```

### Verified against the live endpoint, 2026-07-27

Every one of these was run against `https://asp.untch.xyz` with real signatures from freshly
generated keys:

| Attack | Result |
|---|---|
| Valid signature, **not the policy owner**, against a **real** production policy | `403 NOT_POLICY_OWNER` |
| Exact replay of a message+signature that just succeeded | `401 SIWE_NONCE_REPLAYED` |
| A nonce this server never issued | `401 SIWE_NONCE_REPLAYED` |
| Signature phished for `evil.example` | `401 SIWE_WRONG_DOMAIN` |
| Ethereum mainnet `chainId` | `401 SIWE_WRONG_CHAIN` |
| No `untch:policy:` resource | `401 SIWE_NO_POLICY_RESOURCE` |
| Garbage bearer **plus** a valid `?policyId=` | `401 SESSION_INVALID` — no fallback |
| Public receipt with no auth at all | `200` |

**`CONSUMER_AUTH_REQUIRED` is currently unset**, so `?policyId=` still resolves as *UNPROVEN* for
backwards compatibility, and the ASP boot log says so in as many words. **Set it to `1` before
announcing the scoped routes to third parties.** Until then the routes work but the old path is not
closed. This is the one item in this package that is deliberately left off, and it is a one-variable
change.

---

## 7. Health and manifest endpoints

| Endpoint | Purpose | Live |
|---|---|---|
| `GET /agent-registration.json` | ERC-8004 registration card | ✅ 200 |
| `GET /catalog` | Full ASP catalog (all services) | ✅ 200 |
| `GET /consumer/catalog` | Consumer Pack catalog: providers, real maturity, execution state, auth map | ✅ 200 |
| `GET /ping_untch` | $0.01 rail proof | ✅ 402 v2 |

`/consumer/catalog` is the honest one to point a reviewer at: it reports each provider's **actual**
maturity and `execution.providersExecutableToday`, so a claim in the listing can be checked against
the machine rather than against this document.

---

## 8. Kill-switch procedure

Every switch is fail-closed: only the exact strings `1` and `true` enable anything. A typo, an empty
value, `false`, `yes`, `on`, or an unset variable all mean **off**.

| Scope | Variable | Effect |
|---|---|---|
| Everything | `CONSUMER_PACK_ENABLED=0` | Every `/consumer/*` route answers 503, including reads |
| All spending | `CONSUMER_EXECUTION_ENABLED=0` | Discovery, quoting and status keep working; nothing executes |
| One provider | `CONSUMER_PROVIDER_STABLEDOMAINS_ENABLED=0` | That provider alone stops |
| One rail | `CONSUMER_BASE_ENABLED=0` *(or `CONSUMER_CHAIN_EIP155_8453_ENABLED=0`)* | No settlement on that chain |
| One token | `CONSUMER_BASE_USDC_ENABLED=0` *(or `CONSUMER_ASSET_EIP155_8453_USDC_ENABLED=0`)* | That token alone is refused |

Both flag spellings are read. The CAIP-derived name is canonical and **wins where it is explicitly
set**, so an explicit canonical `=0` cannot be re-enabled by a stale friendly `=1`.

```bash
railway variables --service untch-asp --set "CONSUMER_EXECUTION_ENABLED=0"
railway redeploy --service untch-asp --yes
```

There is also a **database-level** pause that needs no deploy — `consumer_pauses` rows scoped to a
chain, provider or globally, checked on every capability issuance. Use this when a deploy is too
slow.

---

## 9. Pre-submission checklist

Ticked items were verified against live production on 2026-07-27.

- [x] `https://asp.untch.xyz/consumer/catalog` returns 200 and lists real maturity per provider
- [x] Every registered endpoint 402s correctly, with `resource.url` on **https** (the `trust proxy`
      fix in `edbfb64`) — re-verified after this deploy on all seven priced routes
- [x] `GET /agent-registration.json` renders (ERC-8004 card unchanged)
- [x] Every registered service's execute path either works or is not registered
- [x] Migrations `007`, `008`, `009` applied to the production database
- [x] `CONSUMER_ALLOW_SANDBOX_EXECUTION` unset (`sandboxExecutionAllowed: false` in the live catalog)
- [x] Existing services unchanged and still 402ing
- [x] Public receipt reachable with no auth, and withholding the request payload and correlation id
- [x] SIWE ownership proof live; replay, cross-tenant, wrong-domain and wrong-chain all refused
- [ ] **`CONSUMER_AUTH_REQUIRED=1`** — deliberately not yet set; see §6
- [ ] An externally funded Consumer Intent — blocked, see §10

---

## 10. Known gaps, stated plainly

Three things a reviewer might otherwise assume are true.

1. **No production execution has produced a §7.4 receipt yet.** The one real settled purchase was
   driven by the live smoke script, which passed no receipt writer, so it reads `NOT_RECORDED`. The
   receipt path itself is sound — projection, draft and both durable inserts were replayed against
   the production schema in a rolled-back transaction and all succeed for that exact intent — and the
   driver now wires the real writer. It has simply not been run again since.

2. **The user-funded leg has not been exercised by an external wallet.** Every execution so far was
   funded from Untch's own treasury. Proving the leg requires an independent funder key
   (`CONSUMER_TEST_FUNDER_PRIVATE_KEY`), which is not present in any environment. Until that runs,
   the claim is "Untch pays merchants on their own rail under policy", **not** "users fund intents".

3. **`CONSUMER_AUTH_REQUIRED` is off.** See §6. The proof path works and is verified live; the
   legacy unproven path is still open until this is set.

None of these blocks registering services 6–8 as scoped above, because none of the three claims the
listing makes depends on them.

---

## 11. Demo for reviewers

```bash
pnpm consumer:demo              # one complete governed transaction, end to end
pnpm consumer:demo --escalate   # the human-approval path
pnpm consumer:demo --blocked    # a policy refusal
pnpm consumer:demo --ambiguous  # the suspense / manual-review path
```

It names its two fakes on stdout — the provider's HTTP responses, replayed from a real captured 402,
and the settlement signature — and runs the production code path for everything else.
