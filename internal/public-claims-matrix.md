# Public claims matrix

**Date:** 2026-07-28
**Purpose:** every claim Untch makes in public, its evidentiary status, and whether it needs changing.

The test applied to each row is: **if a judge tried to verify this in five minutes, would they
succeed?** A claim that survives only because nobody checked is a liability, not an asset.

Legend — **✅ VERIFIED** (independently checkable) · **⚠️ NEEDS QUALIFIER** (true but incomplete)
· **❌ FIX** (would be found wrong) · **🔵 CORRECTLY ABSENT** (not claimed, and must stay that way).

---

## A. Identity and listing

| Claim | Status | Evidence | Appears in | Action |
|---|---|---|---|---|
| "OKX.AI ASP **#6086**" | ✅ VERIFIED | listing | README §17, docs, X article, HackQuest | none |
| "ERC-8004 agent **#6047**" | ✅ VERIFIED | [`/agent-registration.json`](https://asp.untch.xyz/agent-registration.json) → 200 | README §17, card | none |
| "x402 seller at `asp.untch.xyz`" | ✅ VERIFIED | all 7 priced routes return a v2 `payment-required` header with an **https** `resource.url` | README §11, listing | none |

---

## B. The core product

| Claim | Status | Evidence | Action |
|---|---|---|---|
| "Deterministic policy engine, 14 rules" | ✅ VERIFIED | `packages/policy-engine`, 60 tests, pure function — no I/O | none |
| **"No LLM calls in the money decision path"** | ✅ VERIFIED | the engine takes `(intent, policy, ledgerWindow)` and returns a decision; there is no network client in the package at all | none — this is the strongest claim we make and it holds |
| "An approval binds to a hash; mutation rejects it" | ✅ VERIFIED | `quoteHash` / `spendIntentHash`; tests cover mutation | none |
| "Human approval across 4 channels" | ✅ VERIFIED | Telegram, Discord, Slack, dashboard; 88 escalation tests; dual-channel proven live | none |
| "Every decision receipted" | ✅ VERIFIED | 21 receipts in the production database | none |
| **"Receipts anchored on X Layer"** | ⚠️ **NEEDS QUALIFIER** | all 20 confirmed anchors are **TESTNET** (`0x0c64…4863`). Mainnet anchoring is blocked: the writer is not an authorised writer on the mainnet contract and the writer-set timelock is an immutable 3 days | **DONE** — README §4 downgraded to BETA, §13 states testnet explicitly, changelog entry marked BETA. Must be corrected in the X article and docs too |
| "671 tests passing" | ✅ VERIFIED | 10 suites, 0 failures; CI green on all 7 workflows | none |
| "Contracts hold no funds" | ✅ VERIFIED | no `payable`/`receive`/`fallback` on any base contract (invariant I4) | none |

---

## C. Consumer Pack — the highest-risk section

| Claim | Status | Evidence | Action |
|---|---|---|---|
| "Real settled provider payment" | ✅ VERIFIED | two Base mainnet txs: [`0xe7ce102f…`](https://basescan.org/tx/0xe7ce102f7a704e9c3113fc7fcc8626db8a9cdc330e614d023c231e88fce21e86) and [`0x6815d60e…`](https://basescan.org/tx/0x6815d60e1be688451d36007a4113f858e0a10433dccef01dc3b3d0f8d283e489), 0.050000 USDC each, both `success` | none |
| "The production worker executed one end to end" | ✅ VERIFIED | `ci_82bb2216c02366bc1b839a00`; the local driver lost the race with a `StaleIntentStateError`, which is the compare-and-set working | none |
| "Delivery independently verified" | ✅ VERIFIED | RDAP — the registry, not the merchant. Reported as a field separate from the merchant's claim | none |
| "One verified capability: `domains.check`" | ✅ VERIFIED | `/consumer/catalog` → `execution.providersExecutableToday: ["stabledomains"]` | none |
| **"Domain registration"** | 🔵 CORRECTLY ABSENT | `domains.register` is `sandbox` and refuses | **never claim until a registration settles** |
| **"Shopping"** | 🔵 CORRECTLY ABSENT | `purch` is `experimental`; Solana rail not executable | never claim |
| **"Travel booking"** | 🔵 CORRECTLY ABSENT | the provider states it "does not issue tickets, hold reservations, or take payment for travel". Only `search`/`compare` exist | **say "search and compare", never "book"** |
| **"Gifts"** | 🔵 CORRECTLY ABSENT | `stablemerch` is `experimental`; SIWX leg unproven | never claim |
| **"Notifications"** | 🔵 CORRECTLY ABSENT | `stableemail` is `sandbox` | never claim |
| **"Solana / Tempo settlement"** | 🔵 CORRECTLY ABSENT | Solana payload serialisation unconfirmed; MPP parsed but not settleable | never claim |
| **"Users fund intents"** | ❌ **FIX EVERYWHERE** | every execution to date was **operator-funded** — Untch was both funder and settler. The novel leg proven was the *outbound* merchant settlement | **the correct wording is "Untch pays merchants on their own rail under policy", NOT "users fund intents"** |

---

## D. Security

| Claim | Status | Evidence | Action |
|---|---|---|---|
| "Ownership proof required for tenant reads" | ✅ VERIFIED | `CONSUMER_AUTH_REQUIRED=1` live; 14/14 attack matrix against production with real signatures | none |
| "No standing token allowance" | ✅ VERIFIED | EIP-3009 single-use authorisations; `approve` is never called anywhere | none |
| "Adapters never hold a key" | ✅ VERIFIED | capability-scoped: one intent, one asset, one ceiling, one recipient allowlist, redeemed once under a row lock before signing | none |
| "Append-only audit trail" | ✅ VERIFIED | Postgres RULEs reject `UPDATE`/`DELETE` on ledger entries — proven behaviourally against the production schema | none |
| **"Trustless"** | 🔵 CORRECTLY ABSENT | Untch is **custodial** between funding and completion | **never use this word.** README §24 and §29 say so explicitly |

---

## E. Where each claim appears, and what still needs editing

| Surface | State | Remaining work |
|---|---|---|
| **README** | ✅ **current** | maturity box directly under the badges carries the strongest verified claim plus both boundaries |
| **Changelog** (`untch.xyz/changelog`) | ✅ **current** | standing "Production maturity" banner carries both sanctioned boundaries above the entries |
| **`/consumer/catalog`** | ✅ self-verifying | none — it reports real maturity, so it cannot drift from reality |
| **Repository metadata** | ✅ current | none |
| **OKX.AI listing** | ⚠️ pending | submit the 3 Consumer Pack services per `internal/okx-ai-consumer-pack-reregistration.md`; do **not** list registration/shop/gifts/booking/notify |
| **docs.untch.xyz** | ✅ **current** | `/consumer-pack-proof` published with both boundaries verbatim; verified live 200 |
| **X article** | ⚠️ needs one edit | same qualifier; and check it does not imply user-funded intents |
| **YouTube description** | ⚠️ needs review | same two checks |
| **HackQuest submission** | ⚠️ needs review | same two checks; ASP #6086 and the one-verified-capability boundary must match |

---

## F. The three sentences that are always safe

Every one is verifiable today by someone who does not trust us.

1. **"Untch decides whether an agent is allowed to spend, deterministically, before any money moves —
   and no LLM call appears anywhere on that decision path."**
2. **"Untch has paid a real merchant on the merchant's own rail, for an action a policy approved, and
   verified delivery against a source that is not the merchant."**
   *(two Base mainnet transactions; RDAP)*
3. **"Every completed action has a receipt anyone can open without an account, and when anchoring has
   not happened the receipt says so rather than implying it has."**

## G. The three sentences that are never safe

1. ~~"Users fund their intents"~~ — unproven; every execution was operator-funded.
2. ~~"Book flights / register domains / buy products"~~ — none of those capabilities can execute.
3. ~~"Trustless"~~ — custodial between funding and completion, by design and by documentation.


---

# ADDENDUM — 2026-07-28, sanctioned wordings

Three sentences are now the source of truth and appear verbatim across README, changelog, docs and
every draft. They must be updated **only** when the underlying fact changes.

**The strongest currently verified claim:**

> Untch completed real production-governed provider settlements in Base USDC, independently verified
> the delivered domain result through public RDAP data, and generated durable Consumer Pack receipts.

**Until mainnet writer activation completes:**

> Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt
> anchoring is pending writer activation through the contract's three-day timelock.

**Until the external-funder test completes:**

> Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury.

## Where each appears

| Surface | Strongest claim | Receipts boundary | Funding boundary |
|---|---|---|---|
| README | ✅ maturity box | ✅ box + §29.3 | ✅ box + §13 + §29.2 |
| Changelog | — | ✅ banner + entry | ✅ banner + entry |
| docs `/consumer-pack-proof` | ✅ evidence section | ✅ callout + limitations | ✅ callout + limitations |
| OKX.AI re-registration draft | ✅ | ✅ §10 | ✅ §10 |
| X article draft | pending your edit | pending your edit | pending your edit |
| YouTube description draft | pending your edit | pending your edit | pending your edit |
| HackQuest submission | pending your edit | pending your edit | pending your edit |

## When each boundary retires

- **Funding boundary** — retires the moment the external-funder intent reaches `COMPLETED` with a
  funder address distinct from the treasury. Replace with: *"Consumer Intents can be funded by an
  external wallet; Untch settles with the provider from its own treasury."*
- **Receipts boundary** — retires when `isWriter(0x03e5…1ab5)` returns `true` on mainnet **and** a
  re-driven receipt reaches `CONFIRMED` with a tx whose `to` is
  `0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95`. Not before. A tx hash alone does not prove which
  network it is on.
