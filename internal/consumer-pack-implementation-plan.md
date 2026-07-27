# Untch Consumer Pack — Implementation Plan

**Branch:** `feat/consumer-pack`
**Baseline commit:** `edbfb64` (`fix(asp): trust proxy so x402 resource.url is https behind Railway TLS`)
**Author:** implementation session, 2026-07-27
**Status:** grounded in a full read of the repository and in **live protocol probes** of every candidate provider (evidence captured 2026-07-27, reproduced under `internal/consumer-pack-evidence/`).

> This document is the contract for the build. Where it says a provider is `sandbox` or `disabled`, that
> is a factual statement about what has actually been proven, not a roadmap aspiration. Nothing in this
> plan describes a fixture as a live integration.

---

## 0. Executive summary

Untch already is a governance control plane: deterministic policy preflight (§7.1), durable escalation +
human approval (§7.2/§27), durable receipts anchored on-chain (§7.4/§10.3), a canonical intent hash (§9),
and a proven x402 rail on X Layer mainnet. What it does **not** have is the ability to *carry out* a
consumer action and prove the money landed where the mandate said it would.

The Consumer Pack adds exactly that missing half, and nothing else:

1. A **Consumer Intent** — one durable, state-machined record per real-world action.
2. A **provider layer** — typed adapters over verified external merchants, with maturity gating.
3. A **routed treasury** — pre-funded per-rail operational floats, capability-scoped, never handing a
   private key to an adapter.
4. A **double-entry ledger** — user funding, provider settlement, fee, remainder; append-only.
5. An **asynchronous workflow** — outbox → worker → SSE, so no HTTP request is held open across a purchase.

The core value stays where it is. Every paid action becomes an Untch intent, passes the existing policy
engine, uses the existing approval pipeline, and terminates in a receipt. The provider catalogue is
replaceable; the authority boundary is not.

---

## 1. Current repository architecture

### 1.1 Workspace

pnpm 10.33.0 workspace, Node ≥ 22.4, ESM-only TypeScript run through `tsx` (no build step for services).

```
packages/          12 libraries, all `@untch/*`, `workspace:*`, main = src/index.ts (raw TS)
services/asp/      the single A2MCP seller (Express 4 + @okxweb3/x402-express)
apps/web/          Next.js 16.2.10 / React 19 operator dashboard (app router, server components)
apps/docs/         self-hosted docs site
contracts/         Foundry; solc 0.8.34 pinned, via_ir, deny=warnings
scripts/           tsx operator/proof drivers
.github/workflows/ canon, contracts, escalation, gov-watch, policy-engine, receipt-writer, web
```

**Type strictness (root `tsconfig.json`, and identically in `services/asp` and `apps/web`):**
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `moduleResolution: bundler`,
`target ES2022`. This is unusually strict and materially constrains the code: optional properties must be
conditionally spread (`...(x ? { k: x } : {})`), and every index access is `T | undefined`.

**Root `pnpm typecheck` covers only `packages/**` and `scripts/**`.** `services/asp` and `apps/web` have
their own tsconfigs. `apps/web` is covered by `web.yml`; **`services/asp` is covered by no workflow at all
and `pnpm test:asp` runs nowhere in CI.** That is a pre-existing coverage hole this work must close,
because the Consumer Pack's HTTP surface lives there.

**Test idiom:** `node --import tsx --test`, `node:test` `describe`/`test`, `node:assert/strict`. No vitest,
no jest.

### 1.2 The ASP service

`services/asp/src/server.ts:121` `createSellerApp(config, receiptWiring, policyWiring, escalationWiring, scoreWiring, reportWiring)`.

Ordering is load-bearing and must be preserved:

1. `app.set("trust proxy", 1)` — Railway terminates TLS; without this the x402 `resource.url` is `http:`
   and stops matching the marketplace listing (this is what `edbfb64` fixed).
2. `paymentMiddleware(routes, resourceServer)` **before** `express.json()` — an unpaid request to a priced
   route 402s without the body ever being parsed.
3. `express.json({ limit: "64kb" })`.
4. `HEAD`/`GET` on POST-only priced routes return `405` **after** payment — a paid compatibility probe
   must never execute a business operation.

Every handler returns `HandlerResult = { status: number; body: Record<string, unknown> }`
(`services/asp/src/handlers.ts:36`) and the Express layer forwards it via `send()`. Errors use the §11
envelope `{ code, message, retryable, docsUrl }` (`handlers.ts:43`), with `docsUrl: null` rather than a
fabricated link.

Each `init*Wiring()` returns `T | null`; `null` means the capability is genuinely unconfigured, and the
route answers `503` with a specific code (`POLICY_STORE_NOT_CONFIGURED`, `SCORE_STORE_NOT_CONFIGURED`, …).
**This "honest null" pattern is the repository's central idiom and the Consumer Pack must follow it
exactly**: an unconfigured treasury or provider must 503 with a named reason, never degrade to a mock.

Existing route table (`services/asp/src/config.ts`):

| Route | Price | Notes |
|---|---|---|
| `GET /ping_untch` | $0.01 | rail proof |
| `POST /create_spend_intent` | bundled | canon hash + policy binding + optional on-chain anchor |
| `POST /preflight_payment` | $0.05 | real §7.1 engine vs stored policy |
| `POST /verify_delivery` | $0.10 | §13/§7.3 T0 proof |
| `POST /detect_duplicate` | $0.02 | |
| `POST /redact_payment_metadata` | $0.02 | |
| `POST /score_vendor` · `/score_buyer` | $0.20 | §12 bureau |
| `POST /generate_dispute_packet` | $0.50 | §11 reports |
| `POST /reconcile_agent_spend` | $0.25 | §11 reports |
| `POST /cafe/order/latte` | $0.04 | demo voucher (`DEMO_VOUCHER`, self-declared) |
| `POST /builder/brand_pack` | $0.05 | names + live RDAP + rank + SEO |
| `POST /builder/suggest_names` | $0.01 | |
| `GET /catalog`, `POST /builder/{check_domains,rank_options,seo_tips}` | free | |
| `GET /receipt_status/:receiptId`, `GET /escalation_status/:pollRef` | free | polls |
| `GET /agent-registration.json`, `GET /.well-known/agent-registration.json` | free | ERC-8004 card |

### 1.3 Postgres

One shared Railway Postgres. All packages migrate into the **same** `schema_migrations` table using a
shared advisory lock key `4021_1003`, with **globally unique, forward-only numbered filenames**:

| File | Owner | Tables |
|---|---|---|
| `001_init.sql` | receipt-writer | `batches`, `receipts`, `ledger_entries` |
| `002_policies.sql` | policy-store | `policies` |
| `003_escalations.sql` | escalation | `escalations` |
| `004_operators.sql` | escalation | `escalation_operators`, `escalation_operator_bindings`, `policy_approvers` |
| `005_verify_provenance.sql` | receipt-writer | `receipts.provenance` column |
| `006_score_snapshots.sql` | trust-bureau | `score_snapshots` |

**The Consumer Pack therefore owns `007_…` onwards.** It must reuse `createPool` / `runMigrations` of the
same shape (`packages/policy-store/src/db.ts`) and the same advisory-lock key.

### 1.4 Queue / worker infrastructure already provisioned

- **ioredis 5.10.1** (pinned by a root `pnpm.overrides`) + **BullMQ**.
- `@untch/receipt-writer` owns `createRedis` and the `untch-receipt-ticks` queue; `@untch/escalation`
  **re-exports `createRedis` verbatim** rather than opening a second connection, and adds a distinct
  `untch-escalation-timeouts` delayed queue on the same instance.

**Decision: the Consumer Pack reuses the same Redis + BullMQ, adding its own queues. No new broker.**
The repository's stated rule ("Redis is a convenience, not the authority") carries over: the Postgres
outbox is the record, the BullMQ tick is a latency optimisation, and a periodic sweep is the backstop.

### 1.5 Policy engine

`evaluateIntentSerialized(intent, policy, ledger, opts)` — pure, deterministic, **no LLM (invariant I1)**,
fail-closed (**I2**). 13 `RULE_EVAL` rules; the emitted `Decision` (`packages/policy-engine/src/types.ts:325`)
is `{ decision, intentHash, policyId, policyVersion, evaluatedAt, reasons[], rules[] }` and the ASP
**surfaces it verbatim** — it never rewrites a decision, reason, or trace entry. Serialization is per
`ledgerPartitionKey(policy.id)`.

`SpendIntentInput` carries two deliberate money representations: `maxAmount: bigint` (base units, the
hashed §8.1 struct field) and `amount: number` (display units, what budget/per-call/escalate rules read).

### 1.6 Approval / escalation

`EscalationService` (`packages/escalation/src/service.ts`) is the §7.2 state machine and the §27 authority
boundary. Contract points the Consumer Pack must reuse unchanged:

- `createEscalation(req, { restrictToChannels })` — **idempotent by `pollRef`** (a repeat returns the
  existing record and does not re-mint a code).
- `pollRef` is `receiptRef.receiptId ?? intentHash` — the exact key x402-guard's `poll()` computes.
- Channels **never** make money decisions. `handleInbound` re-checks binding, single-use code, expiry,
  channel cap and the dual-channel rule before anything counts.
- Derived expiry: an open escalation past `code_expires_at` reads as DENIED even if Redis lost the job.
- Five channels exist: Telegram, Discord, Slack, Dashboard (SIWE-identity-authorised), Photon.

### 1.7 Receipts

`ReceiptEnqueuer.enqueue(input, decision)` / `.enqueueVerify(input, ctx)` — durable Postgres write first
(receipt + ledger row in one transaction), best-effort BullMQ tick, immediate `{ receiptId, status: "QUEUED" }`.
Anchoring is the worker's job. `ReceiptKind` is currently `"DECISION" | "VERIFY"`; `types.ts:66` already
names the future kinds — `SCORE_ROOT`, `AUDIT`, `VAULT_SPEND`, `BROKER_SETTLE`.

### 1.8 Chains, tokens, contracts

`packages/shared/src/chains.ts` is the single network-selection source, driven by `CHAIN_ID` / `NETWORK`
(CAIP-2) with `RPC_URL` override. It carries a **`ConfirmedToken | UnconfirmedToken` discriminated union**:
a token with no officially verified address is stored as `{ address: null, reason }` and is excluded from
every allowlist *by construction*. This is the exact posture the Consumer Pack's asset registry must adopt.

Deployed (X Layer): `PolicyRegistry`, `SpendIntentRegistry`, `UntchReceipts`, `UntchVaultFactory` on both
testnet 1952 and mainnet 196. **No `UntchVault` instance exists on mainnet** — vaults are per-operator via
the factory.

### 1.9 Web app

Next.js 16 app router, server components with `export const dynamic = "force-dynamic"`, reading the shared
Postgres directly through `lib/dashboard/db.ts`. SIWE auth (`lib/auth/*`, `app/api/auth/*`), wagmi +
RainbowKit with OKX Wallet priority, `NetworkGuard` normalising the chain before SIWE. Shared primitives
live in `components/dashboard/ui.tsx` (`DashCard`, `SectionTitle`, `StatTile`, `Meter`, `DecisionChip`,
`MastheadLink`). Colour is **only** via design tokens — `style={{ color: "var(--color-data)" }}`,
`accent="signal" | "text" | "data" | "positive"`. No raw hex, no gradients.

---

## 2. Reusable existing components

| Consumer Pack need | Decision | Why |
|---|---|---|
| Policy evaluation | **REUSE** `@untch/policy-engine` | It is the product. A consumer quote is projected into a `SpendIntentInput` and evaluated by the same 13 rules; no second policy path may exist. |
| Policy storage / binding | **REUSE** `@untch/policy-store` | `policyId` → `StoredPolicy` with `policyHash`; the same `intentBoundToPolicy` check. |
| Canonical hash | **REUSE** `@untch/canon` | `hashSpendIntent` gives the `intentHash` that threads to the receipt. |
| Human approval | **REUSE** `@untch/escalation` | Idempotent-by-`pollRef` create, §27 boundary, 5 channels, fail-closed expiry. Building a second approval path would fork the authority boundary. |
| Receipts + anchoring | **REUSE** `@untch/receipt-writer` | Durable-first enqueue + batched anchor. Extend `ReceiptKind` with `CONSUMER` rather than writing a parallel writer. |
| Postgres pool + migrations | **REUSE** the shared `db.ts` shape + advisory lock | One database, one `schema_migrations`. |
| Redis + BullMQ | **REUSE** `createRedis` from receipt-writer | Explicit precedent set by escalation. |
| Chain/token registry | **EXTEND** `packages/shared/src/chains.ts` | Add Base 8453 + Solana mainnet + Tempo 4217 using the same confirmed/unconfirmed union. |
| x402 **inbound** (being paid) | **REUSE** `@okxweb3/x402-express` | Already wired; **`DynamicPrice` is supported** (see §6). |
| x402 **outbound** (paying a provider) | **BUILD NEW** | `pay-remote.ts` is a single-purpose D0.1 driver, not a client. `@untch/x402-guard` validates a challenge but deliberately never signs. |
| Challenge binding | **REUSE** `@untch/x402-guard` | `ChallengeBinding` + `BLOCKED_REPLAY`/`REJECTED_BINDING` is exactly the anti-context-swap primitive the outbound path needs. |
| Consumer Intent lifecycle | **BUILD NEW** | No stateful, long-running action record exists today; `SpendIntentInput` is a single-shot decision input. |
| Money type | **BUILD NEW** | Today money is `bigint` base units *or* `number` display units depending on layer. Neither carries chain/token/decimals. |
| Treasury | **BUILD NEW** | Nothing outbound-funded exists. |
| Double-entry ledger | **BUILD NEW** | `ledger_entries` is single-sided and receipt-scoped. |
| Outbox / SSE | **BUILD NEW** | No event stream exists. |
| Operator UI shell | **REUSE** `components/dashboard/*` + tokens | New pages must be indistinguishable from existing ones. |

---

## 3. Provider verification matrix

Every row below was produced by an **actual HTTP request on 2026-07-27**, not from the research reports.
Raw evidence is committed under `internal/consumer-pack-evidence/`.

### 3.1 What the probes established about the protocols

Three distinct mechanisms are in play, and the research reports conflated them:

1. **x402 v2** — `PAYMENT-REQUIRED` response header, base64 JSON:
   `{ x402Version: 2, resource, accepts: [{ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }], extensions }`.
   - On `eip155:8453` (Base), `extra` is `{ name: "USD Coin", version: "2" }` — i.e. the **EIP-712 domain
     for EIP-3009 `transferWithAuthorization`**. This is the *same scheme* Untch already settles on X Layer
     with USDT0. It is directly implementable with `viem`.
   - On `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `extra` is `{ feePayer }` — a sponsored SPL transfer.
2. **MPP** — `WWW-Authenticate: Payment id="…", realm="…", method="tempo", intent="charge", request="<b64>"`,
   where `request` decodes to `{ amount, currency: "0x20c0…b9537d11c60e8b50", methodDetails: { chainId: 4217 }, recipient }`.
3. **SIWX** — a 402 with **`accepts: []`** plus `extensions["sign-in-with-x"]`. This is *authentication, not
   payment*: a SIWE-shaped struct (`domain, uri, version, chainId: "eip155:8453", type: "eip191", nonce,
   issuedAt, expirationTime, statement`) to be signed with `personal_sign` and returned in a
   `SIGN-IN-WITH-X` header. **An empty `accepts` array is the reliable discriminator.**

This matters: **StableMerch's `/api/catalog` and `/api/drafts` are SIWX-gated, not paid** — a naive x402
client would loop forever on an empty `accepts`.

### 3.2 Matrix

| Provider | Endpoint(s) probed | Live result | Rails offered | Maturity **as shipped** |
|---|---|---|---|---|
| **StableDomains** `stabledomains.dev` | `POST /api/search`, `/api/check`, `/api/register`, `/api/domain/renew`, `/api/domain/dns`; `GET /openapi.json`, `/.well-known/x402` | 402 with populated `accepts` on all four paid paths; full OpenAPI + `.well-known` | **Base USDC** (`0x8335…2913`, payTo `0xABcb…1892`) **and** Solana USDC; MPP/Tempo advertised | **`sandbox`** |
| **StableEmail** `stableemail.dev` | `POST /api/send`; `GET /openapi.json`, `/.well-known/x402` | 402, `accepts` populated; `x-payment-info` fixed $0.02 | **Base USDC** (payTo `0xdb5a…0671`) and Solana USDC | **`sandbox`** |
| **StableTravel** `stabletravel.dev` | `GET /openapi.json` (45 paths), `/api/health` | 200; **`x-guidance` states plainly: "It does not issue tickets, hold reservations, or take payment for travel… There are no hotel, activity, or ground-transfer endpoints."** | Base / Solana / Tempo per docs | **`sandbox` — DISCOVERY ONLY** |
| **StableMerch** `stablemerch.dev` | `GET /api/catalog`, `POST /api/drafts`, `GET /openapi.json`, `/.well-known/x402` | 402 with **empty `accepts`** + SIWX extension on both; only `/api/drafts/{id}/commit` carries `x-payment-info` (dynamic $0.01–$50.00, x402 + MPP) | Base/Solana x402 + MPP Tempo on commit; **SIWX for everything before it** | **`experimental`** |
| **Purch** `api.purch.xyz` | `GET /x402/search`, `/x402/shop`, `/x402/vault/search`, `/x402/vault/download`; `GET /openapi.json` | 402 with populated `accepts`; 7-endpoint OpenAPI | **Solana USDC only** — no Base option in any challenge | **`experimental`** |
| **Travala Travel MCP** | — | **not probed: MCP transport, not an HTTP x402 resource; no endpoint reachable without an MCP session** | — | **`disabled`** |
| **Trips.sh** | — | **not probed: no public API documentation of comparable quality** | — | **`disabled`** |

### 3.3 Corrections to the research reports

The reports are the *starting point*; the live probes overrule them. Three claims did not survive:

1. **`deep-research-report (4).md` line 41** — "AgentCash's flight-booking category page… describes 74
   endpoints on `stabletravel.dev` for flight offers, hotels, activities, transfers… and end-to-end booking
   and cancellation flows." **False.** The live OpenAPI has 45 paths, zero hotel/activity/transfer paths,
   and its own guidance explicitly disclaims booking. StableTravel is a *flight-data* provider.
2. **Both reports** treat StableMerch as a straightforward x402 purchase surface. In fact the entire
   draft/preview/prepare flow is **SIWX-gated**, and only `commit` is payable.
3. **`deep-research-report (5).md` line 43** implies StableDomains registration is a simple paid call.
   In fact `/api/register` has a **prerequisite**: a verified ICANN registrant profile
   (`POST /api/profile` → `POST /api/profile/verify-email`, both **SIWX**, with a 6-digit email OTP).
   A domain registration is therefore a *multi-leg* flow with a human-in-the-loop email step.

### 3.4 The maturity ladder, and why nothing ships `verified`

```
verified     — a real settled payment has been observed against this provider from an Untch treasury
               wallet, and the delivery evidence was verified. ONLY these may be used by production
               execution routes.
sandbox      — adapter implemented, schemas validated against the live spec, protocol shape confirmed
               from a real 402, unit-tested against captured fixtures. NO live settlement yet.
experimental — reachable and partially understood, but a required leg is unverified (SIWX identity,
               a rail we cannot yet settle, or a non-idempotent flow with unconfirmed semantics).
disabled     — not integrated. Cannot be selected at all.
```

**No provider ships `verified` in this branch, and the code makes that impossible to fake.** The reason is
factual and unavoidable: promoting to `verified` requires a *funded treasury wallet* on Base and/or Solana.
`.env` contains `OKX_API_KEY/SECRET/PASSPHRASE`, `OPS_WALLET_ADDRESS` (a public address), and the
Telegram/Discord/Slack tokens — and **no treasury private key of any kind**. Without one, no outbound
settlement can occur, so no provider can honestly be called live.

`ProviderRegistry.assertExecutable()` therefore hard-refuses any provider below `verified` on a production
execution route, and `CONSUMER_ALLOW_SANDBOX_EXECUTION=1` is required (and loudly logged, and surfaced in
the UI and in every receipt) to execute against a `sandbox` provider in a non-production environment.

---

## 4. Proposed service schemas (public A2MCP surface)

Narrow, typed tools — never one untyped action endpoint. All under the existing ASP.

### Untch Shop
| Route | Price | Body → Result |
|---|---|---|
| `POST /consumer/shop/search` | $0.02 | `{ policyId, query, priceMax?, brand?, page? }` → normalised `products[]` + `providerId` + `discoveryId` |
| `POST /consumer/shop/product` | $0.01 | `{ policyId, providerRef }` → product detail |
| `POST /consumer/shop/quote` | $0.05 | `{ policyId, providerRef, shipping, email }` → `ConsumerIntent` in `QUOTED`/`AWAITING_APPROVAL` + `quote` + `quoteExpiresAt` + `fundingRequest` + `statusUrl` + `eventsUrl` |
| `POST /consumer/shop/purchase` | $0.05 | `{ intentId }` → accepted (`202`) + current state; execution is asynchronous |
| `GET  /consumer/shop/order/:intentId` | free | order + delivery status |

### Untch Domains
`POST /consumer/domains/check` ($0.02) · `POST /consumer/domains/quote` ($0.05) ·
`POST /consumer/domains/register` ($0.05) · `POST /consumer/domains/renew` ($0.05) ·
`GET /consumer/domains/status/:intentId` (free) · `POST /consumer/domains/dns` ($0.05, **SIWX-gated →
`experimental`**).

### Untch Travel
`POST /consumer/travel/search` ($0.03) · `POST /consumer/travel/compare` ($0.02) ·
`POST /consumer/travel/quote` ($0.05) · `POST /consumer/travel/book` ($0.05) ·
`GET /consumer/travel/booking/:intentId` (free).

**`quote`/`book`/`booking` return `PROVIDER_CAPABILITY_UNAVAILABLE` (501) while no verified provider
declares the `travel.book` capability.** They exist as typed contracts so the capability can be filled by a
future adapter without an API change — they do not pretend to book.

### Untch Gifts
`POST /consumer/gifts/quote` ($0.05) · `POST /consumer/gifts/order` ($0.05) ·
`GET /consumer/gifts/status/:intentId` (free).

### Untch Consumer Status
`GET /consumer/intent/:intentId` · `GET /consumer/intent/:intentId/payment` ·
`GET /consumer/intent/:intentId/delivery` · `GET /consumer/intent/:intentId/receipt` ·
`GET /consumer/intent/:intentId/events` (SSE) — all free.

### Untch Consumer Notify
`POST /consumer/notify/confirmation` ($0.03) · `POST /consumer/notify/receipt` ($0.03) ·
`POST /consumer/notify/exception` ($0.03).

### The funding route (the variable-value leg)
`POST /consumer/fund/:intentId` — **x402 with `DynamicPrice`**, priced at the exact authorised amount in
X Layer USDT0. See §6.

---

## 5. Data model

New migration **`007_consumer_pack.sql`**, same shared database.

| Table | Purpose | Key invariant enforced in SQL |
|---|---|---|
| `consumer_intents` | one row per action; the state machine | `state` CHECK against the 22 states; `UNIQUE (tenant_id, idempotency_key)` |
| `consumer_quotes` | immutable quote snapshots | `quote_hash` unique; never updated |
| `provider_registry` | providerId, maturity, base URL, protocol, rails | `maturity` CHECK |
| `provider_capabilities` | (providerId, capability) with per-capability maturity | PK (provider_id, capability) |
| `provider_executions` | one row per **attempt**, written **before** the request | `UNIQUE (intent_id, attempt_no)`; `UNIQUE (provider_id, idempotency_key)` |
| `consumer_approvals` | binds an escalation to an intent + the exact approved terms | `UNIQUE (intent_id)`; stores `quote_hash`, `policy_version`, `max_amount` |
| `funding_receipts` | the settled user funding | **`UNIQUE (chain, tx_hash)`** and **`UNIQUE (intent_id)`** — one receipt can never fund two intents |
| `delivery_evidence` | provider-attested + Untch-verified evidence | |
| `ledger_accounts` | chart of accounts | `UNIQUE (kind, chain, token, owner_ref)` |
| `ledger_entries_v2` | **append-only double-entry**; no UPDATE, no DELETE | `CHECK (amount <> 0)`; a rule trigger rejects UPDATE/DELETE |
| `treasury_accounts` | one per (chain, token, purpose) | `UNIQUE (chain, token, purpose)` |
| `treasury_balances` | observed balance snapshots + thresholds | |
| `consumer_outbox` | transactional outbox | `seq BIGSERIAL`; `UNIQUE (intent_id, event_seq)` |
| `consumer_events` | delivered event history for SSE resume | `UNIQUE (intent_id, event_seq)` |
| `idempotency_records` | per-tenant request dedup | `PRIMARY KEY (tenant_id, key)` — cross-tenant collision impossible |
| `provider_health_snapshots` | latency / success-rate / breaker state | |
| `consumer_pause_flags` | kill switches: global / provider / chain / asset / treasury account | |

`ledger_entries_v2` is named to avoid colliding with receipt-writer's single-sided `ledger_entries`, which
stays exactly as it is.

**Balances are never computed from mutable rows.** `treasury_balances` is an *observation* (what the chain
says); authoritative internal position is `SUM(ledger_entries_v2.amount)` per account.

---

## 6. Treasury and settlement model

### 6.1 The two-price rule

The fixed OKX A2MCP call price is the **orchestration fee**. It is not, and must never be conflated with,
the product price. The variable value moves on its own funding leg:

```
1. Agent calls POST /consumer/shop/quote  → pays the FIXED $0.05 ASP fee (x402, X Layer USDT0)
2. Untch discovers inventory, builds an exact quote, stamps quoteExpiresAt
3. Untch runs the REAL policy engine over a SpendIntent projected from the quote
4. If ESCALATED_* → the existing escalation pipeline; approval binds quoteHash + policyVersion + maxAmount
5. Untch returns { intentId, state: AWAITING_FUNDING, fundingRequest: { url, amount, token, chain } }
6. Agent POSTs /consumer/fund/:intentId  → 402 priced by DynamicPrice at the EXACT authorised amount
7. Facilitator settles → funding_receipts row (UNIQUE on tx hash AND on intent) → state FUNDED
8. Worker pays the provider from the PRE-FUNDED float on the provider's own rail
9. Delivery verification → COMPLETED + full cross-rail receipt
```

Step 6 is only possible because `@okxweb3/x402-core` exposes
`DynamicPrice = (context: HTTPRequestContext) => Price | Promise<Price>` and
`Price = string | number | { asset, amount, extra? }`. The route is registered once with a price
*function*, which reads `:intentId` out of `context.path`, loads the intent, and returns
`{ asset: USDT0, amount: <exact atomic> }`. **Verified against the installed
`@okxweb3/x402-core@0.1.0` type declarations** (`x402HTTPResourceServer-BqdilVCp.d.ts:59,90`) — not assumed.

Fail-closed: if the intent is missing, expired, in the wrong state, or its authorised amount is zero, the
price function **throws**, and the route cannot be paid.

### 6.2 Routed treasury, no request-path bridging

```
User funding rail          X Layer (196) USDT0     ← one front door, matches OKX distribution
Provider settlement rails  Base (8453) USDC        ← StableDomains, StableEmail, StableMerch, StableTravel
                           Solana mainnet USDC     ← Purch, and the Solana option on the Stable* family
                           Tempo (4217)            ← MPP; parsed, not executable (see §8)
```

Each rail has a **pre-funded operational float**. There is **no swap and no bridge on the request path** —
the treasury is replenished out of band by a human following a runbook. An `AutoRebalancer` interface is
declared so the seam exists, and it is **hard-disabled**: `NoopRebalancer` is the only implementation and
`assertRebalancingDisabled()` throws if anything tries to enable it, because this repository has no tested
production bridge.

### 6.3 Capability-scoped payment — adapters never see a key

```ts
interface PaymentCapability {
  readonly capabilityId: string;
  readonly intentId: string;
  readonly chain: CaipChainId;
  readonly token: AssetRef;
  readonly maxAmount: Money;          // hard ceiling, enforced at spend time
  readonly allowedRecipients: readonly string[];
  readonly expiresAt: number;
  pay(req: PaymentRequest): Promise<PaymentResult>;   // the ONLY thing an adapter can call
}
```

`TreasuryRouter.issueCapability()` mints one, scoped to a single intent, and **redeems it exactly once**
(`consumed` flag checked under a Postgres row lock). An adapter that tries to pay a different recipient, a
larger amount, a different chain, or twice, gets a typed refusal — it has no other path to funds. Private
keys live only inside the rail clients, which are constructed by the router and never handed out.

### 6.4 Escrow: reuse, do not invent

`UntchVault` / `UntchVaultFactory` exist, but **no vault instance is deployed on mainnet** and its
lifecycle was designed for the agent-spend flow, not for a two-sided consumer settlement. Adding a new
contract "to look complete" is explicitly out of scope.

**Decision: no new contract in this branch.** The funding leg uses the *already-proven* x402 rail, which
gives an atomic, on-chain-settled, tx-hash-bearing funding receipt without new Solidity. The custodial gap
this leaves is stated plainly in `docs/consumer-pack-security.md`: **between `FUNDED` and `COMPLETED`,
Untch holds the value as an operator; this is a custodial ledger, and the documentation says so in those
words. It is not described as trustless anywhere.** Making it non-custodial requires a `ConsumerEscrow`
contract with expiry, replay protection, reentrancy protection, token allowlists, exact-amount binding,
refund paths, verifier binding and emergency pause — which needs its own design and threat model before a
line of Solidity is written, and is filed as the top item in "remaining risks".

---

## 7. Consumer Intent state machine

22 states, exactly as specified. Transitions are validated **centrally** by
`assertTransition(from, to)` against a frozen adjacency map. No controller and no adapter may write
`state` directly — the repository's only mutator is
`transition(intentId, expectedFrom, to, patch)`, which performs a compare-and-set
(`UPDATE … WHERE id = $1 AND state = $2`) and throws `StaleIntentStateError` on 0 rows. This makes
concurrent transitions safe without a distributed lock.

```
CREATED → DISCOVERING → QUOTED → POLICY_CHECKING
POLICY_CHECKING → BLOCKED | AWAITING_APPROVAL | APPROVED
AWAITING_APPROVAL → APPROVED | BLOCKED | EXPIRED | CANCELLED
APPROVED → AWAITING_FUNDING → FUNDED → EXECUTION_QUEUED
EXECUTION_QUEUED → PROVIDER_PAYMENT_PENDING → PROVIDER_PAID → PROVIDER_ACKNOWLEDGED
PROVIDER_ACKNOWLEDGED → DELIVERY_PENDING → DELIVERY_VERIFIED → COMPLETED
any pre-payment failure          → FAILED_BEFORE_PAYMENT → REFUND_PENDING → REFUNDED
any post-payment failure         → FAILED_AFTER_PAYMENT  → MANUAL_REVIEW
ambiguous provider outcome       → MANUAL_REVIEW (terminal until a human acts)
quote/approval expiry            → EXPIRED
```

The **single most important rule**: `FAILED_BEFORE_PAYMENT` may never be reached from any state at or
after `PROVIDER_PAYMENT_PENDING`, and `PROVIDER_PAYMENT_PENDING` on an ambiguous outcome resolves to
`MANUAL_REVIEW`, **never** to a retry. This is asserted as a property test over the whole transition map,
not just spot-checked.

---

## 8. Provider architecture

```ts
interface ConsumerProviderAdapter {
  readonly providerId: string;
  capabilities(): readonly ProviderCapability[];
  health(): Promise<ProviderHealth>;
  discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult>;
  quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote>;
  execute(input: ExecuteInput, payment: PaymentCapability): Promise<ProviderExecution>;
  getStatus(ref: ProviderReference): Promise<ProviderStatus>;
  cancel?(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderCancellation>;
  verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence>;
  normalizeError(err: unknown): NormalizedProviderError;
}
```

`AdapterContext` carries a correlation id, a deadline, a **hardened fetch**, and *no* payment authority.
Only `execute` receives a `PaymentCapability`.

Protocol clients behind interfaces, constructed only by the treasury router:

| Client | Status in this branch |
|---|---|
| `XLayerUsdtFundingClient` | **implemented** — inbound funding leg via the existing OKX facilitator |
| `X402BaseUsdcClient` | **implemented** — x402 `exact` + EIP-3009 `transferWithAuthorization` via viem; deterministic signature tests against captured Base challenges |
| `X402SolanaUsdcClient` | **implemented, `sandbox`** — sponsored SPL transfer payload construction; unit-tested with a fixed keypair and a fixed blockhash. **Never settled live** (no funded Solana treasury). |
| `MppTempoClient` | **challenge parsing only, `disabled`** — the `WWW-Authenticate: Payment` header is parsed and normalised; `execute()` returns `PROTOCOL_NOT_EXECUTABLE`. The MPP charge construction is not implementable from the evidence available, and guessing it would be exactly the kind of unverified claim this plan exists to prevent. |
| `SiwxSigner` | **implemented** — eip191 `personal_sign` over the SIWX struct, `SIGN-IN-WITH-X` header. Reuses viem; no new dependency. |

**Payment verification lives in exactly one place** (`x402/verify.ts` + `@untch/x402-guard`'s
`ChallengeBinding`). An adapter cannot re-implement it: adapters receive an already-selected, already-bound
`PaymentRequest`.

---

## 9. Event and communication flow

Transactional outbox. The state transition and the event row are written **in one Postgres transaction**;
a BullMQ tick nudges the dispatcher; a sweep is the backstop.

Events: `consumer.intent.created`, `consumer.discovery.completed`, `consumer.quote.created`,
`consumer.policy.approved`, `consumer.policy.blocked`, `consumer.approval.required`,
`consumer.approval.completed`, `consumer.funding.requested`, `consumer.funding.confirmed`,
`consumer.execution.started`, `consumer.provider.paid`, `consumer.provider.acknowledged`,
`consumer.delivery.verified`, `consumer.completed`, `consumer.failed`, `consumer.refund.pending`,
`consumer.refunded`, `consumer.manual_review.required`.

SSE at `GET /consumer/intent/:intentId/events`, with `Last-Event-ID` resume, monotonic per-intent
`event_seq`, at-least-once delivery with dedup by `(intentId, seq)`, heartbeat comments, and a polling
fallback (`GET /consumer/intent/:intentId`). Tenant isolation is enforced at the query, not the transport.
Outbound webhooks are signed `HMAC-SHA256` over `timestamp.body` with a per-tenant secret and retried with
capped exponential backoff.

**No HTTP request is ever held open across a purchase.** `POST …/purchase` returns `202` immediately.

---

## 10. Security threat model (summary; full text in `docs/consumer-pack-security.md`)

| Threat | Control |
|---|---|
| Payment replay | x402 nonce + `expiry` bound in `ChallengeBinding`; `funding_receipts UNIQUE (chain, tx_hash)` |
| Quote tampering | `quote_hash` over the canonical quote; the approval stores it; execution re-checks it |
| Policy substitution | approval stores `policy_id` + `policy_version` + `policy_hash`; a changed policy invalidates the approval |
| Approval substitution | approval `UNIQUE (intent_id)`; the escalation `pollRef` is derived, not supplied |
| Duplicate execution | `provider_executions UNIQUE (provider_id, idempotency_key)` + CAS state transition + provider idempotency keys |
| Underpayment / wrong token / chain / recipient | `PaymentCapability` allowlists all four; the rail client re-asserts against the *challenge* |
| Provider webhook forgery | signed webhooks only; unsigned inbound is ignored, never trusted |
| Malicious provider responses | every response parsed by a runtime schema before it touches the domain; unknown fields dropped |
| Prompt injection in product text | provider text is **data**: stored, escaped, never concatenated into any instruction; the control plane is LLM-free (I1) |
| SSRF | provider base URLs come from `provider_registry` only; the hardened fetch resolves the host and refuses private/link-local/loopback ranges and cross-host redirects |
| Log injection / leaks | a redactor strips addresses to `0x1234…abcd`, drops email bodies, shipping addresses, signatures, payment payloads and `SIGN-IN-WITH-X` headers |
| Cross-tenant idempotency collision | `PRIMARY KEY (tenant_id, key)` |
| Chain reorgs | funding requires N confirmations before `FUNDED`; a reorged receipt reverts the intent to `AWAITING_FUNDING` and raises an alert |
| Stale quotes | `quote_expires_at` checked at approval **and again** immediately before provider payment |
| Precision errors | integer atomic units end to end; no `number` ever holds money |
| Unlimited approvals | EIP-3009 authorises an exact amount for an exact recipient — no ERC-20 `approve` is ever issued |
| Treasury depletion | per-provider, per-day and per-account caps; minimum-balance thresholds; alerts; auto-pause on breach |
| Admin endpoint abuse | operator routes behind the existing SIWE session + §27 ownership check |
| Compromised adapter | capability scoping (§6.3) — the blast radius is one intent's authorised amount to one allowlisted recipient |

---

## 11. Latency budgets

| Stage | Budget | Enforcement |
|---|---|---|
| Policy evaluation | 50 ms p99 | in-process, deterministic, no I/O beyond the ledger read |
| Quote creation | 3 s p95 | per-provider timeout 2.5 s; parallel discovery; partial results allowed |
| Funding detection | 30 s p95 | facilitator-settled; synchronous on the x402 response |
| Provider payment | 10 s p95 | rail client timeout |
| Provider acknowledgement | 30 s p95 | worker, off the request path |
| Delivery verification | 5 min p95 | polled by the worker with backoff |

Hot-path rules: pre-funded wallets (no synchronous replenishment), keep-alive agents, cached provider
metadata with a short TTL, parallel independent discovery, strict per-provider deadlines, immediate `202`
for anything long, no LLM anywhere in the money path.

---

## 12. Staged implementation plan

| Phase | Deliverable | Commit |
|---|---|---|
| 1 | `@untch/consumer-core`: money, assets, state machine, domain types, errors, ledger, migration `007` | `feat(consumer-core): …` |
| 2 | provider registry, adapter contract, hardened fetch, x402/MPP/SIWX clients, fixtures | `feat(consumer-providers): …` |
| 3 | treasury router, capability scoping, limits, pause flags, reconciliation | `feat(consumer-core): treasury …` |
| 4 | orchestrator: policy + approval + funding + outbox + worker + SSE | `feat(asp): consumer intent orchestration …` |
| 5 | concrete adapters + the A2MCP routes | `feat(asp): consumer pack routes …` |
| 6 | operator UI | `feat(web): consumer pack surfaces …` |
| 7 | hardening, failure injection, CI, docs, `.env.example` | `chore(ci)` / `docs` |

Small, green, individually-mergeable commits, per `CONTRIBUTING.md`. `pnpm typecheck` plus the affected
suites run before each.

---

## 13. Acceptance criteria → evidence

| # | Criterion | How it will be evidenced |
|---|---|---|
| 1 | ≥3 consumer categories end to end | shop, domains, notify (+ travel discovery, gifts) driven through the full state machine in the e2e suite |
| 2 | ≥2 destination rails | Base USDC (x402 exact/EIP-3009) and Solana USDC (x402 exact/SPL) implemented + unit-tested; X Layer USDT0 on the funding leg |
| 3 | every paid action passes policy | a test asserts no path reaches `EXECUTION_QUEUED` without a `Decision` |
| 4 | variable value separate from the fixed fee | the funding route + `DynamicPrice`; asserted in tests |
| 5 | no request-path bridge/swap | `assertRebalancingDisabled()`; a test asserts the router has no swap path |
| 6 | idempotent execution | duplicate-request and retry-after-timeout tests |
| 7 | every completed action has a receipt | `COMPLETED` requires a receipt row; asserted |
| 8 | receipt completeness | schema test over the cross-rail receipt |
| 9 | failed-before-payment refunds | refund-path test |
| 10 | ambiguous post-payment → manual review | failure-injection test |
| 11 | treasury visible | operator UI + `/consumer/admin/treasury` |
| 12 | kill switches work | pause tests for global/provider/chain/asset |
| 13 | existing suites still pass | full pre-existing test run |
| 14 | CI passes | new `consumer-pack.yml` + `asp.yml`; existing workflows unchanged and green |
| 15 | production build passes | `pnpm --filter @untch/web build` |
| 16 | no secrets committed | `.env.example` placeholders only; a test greps the tree |
| 17 | nothing falsely called live | maturity ladder + the registry's hard refusal; documented |
| 18 | docs match the implementation | docs written last, against the shipped code |

---

## 14. Dependencies and credentials still required

**New runtime dependencies:** `@solana/web3.js` and `@solana/spl-token` (Solana rail only, isolated behind
`X402SolanaUsdcClient` and loaded lazily so the ASP boots without them). Everything else reuses `viem`,
`pg`, `bullmq`, `ioredis`, `express` — all already present.

**Credentials required before any provider can be promoted to `verified`** (none of which exist today):

| Variable | Purpose | Blocking |
|---|---|---|
| `CONSUMER_TREASURY_BASE_PRIVATE_KEY` | Base USDC float signer | Base rail |
| `CONSUMER_TREASURY_SOLANA_SECRET_KEY` | Solana USDC float signer | Solana rail / Purch |
| `CONSUMER_TREASURY_TEMPO_PRIVATE_KEY` | Tempo/MPP float signer | MPP rail |
| funded balances on each rail | actual settlement | all |
| a StableDomains ICANN profile + verified email | `/api/register` prerequisite | domain registration |
| a SIWX identity wallet | StableMerch drafts, StableDomains DNS/profile | merch, DNS |

Until those exist, `verified` is unreachable **by construction**, and the Consumer Pack will say so in the
API, in the UI, and in the receipts.
