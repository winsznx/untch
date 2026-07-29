# Consumer Pack Completeness — plan

**Branch:** `feat/consumer-pack-completeness`
**Base:** `main` @ `0fdf249` (= tag `v0.1.1`, = `origin/main`)
**Opened:** 2026-07-29
**Objective:** activate the remaining consumer layers while the X Layer receipt-writer
proposal serves its immutable three-day timelock. No new architecture — the production-proven
flow is reused end to end.

---

## 0. Pre-flight verification (done before any code changed)

| Question | Answer |
| --- | --- |
| `main` commit | `0fdf249` — "feat: externally funded Consumer Intent proven in production (#16)". Same commit as tag `v0.1.1`. |
| `v0.1.1` release | **Already published** 2026-07-28T11:12:10Z against `0fdf249`. Nothing to release; this phase adds to it. |
| Railway deployment | project `untch-asp` (`a786dc60-…`), service `untch-asp` (`b6a094d9-…`), env `production`, **Online**, `https://asp.untch.xyz`. Deployed from a tarball upload, not a GitHub trigger. |
| Open PRs | none (`gh pr list --state open` → `[]`). |
| Uncommitted changes | `.gitignore`, `internal/day0/D0.1-evidence/*`, `internal/day0/D0.1-payment-sdk-notes.md`, `internal/untch-prd.md`, `package.json`, plus untracked `scripts/SUBMIT-OKX-GENESIS.md` and `scripts/SUBMIT-ONCHAIN-OS.md`. **Carried onto this branch untouched. Not committed by this phase.** |
| Orphaned work | `feat/consumer-pack` still holds two commits that never reached `main`: `31cca18` (docs mobile-drawer portal fix) and `de7a4a5` (mainnet-writer runbook + `scripts/whoami-key.sh`). Left on that branch; flagged for a separate PR. |
| Existing adapters | `purch`, `stabledomains`, `stableemail`, `stablemerch`, `stabletravel` in `packages/consumer-providers/src/adapters/`. |
| Payment clients | `x402/evm-exact.ts` (Base, **working**), `x402/solana-exact.ts` (**stub — returns `PROTOCOL_NOT_EXECUTABLE`**), `mpp/challenge.ts` (parses Tempo MPP, **cannot execute**). |
| Consumer Session | **Does not exist.** `services/asp/src/consumer/auth.ts` implements a SIWE→Bearer *auth session*, which is authentication, not a funded spending session. Section 7 builds the real thing. |
| Maturity flags | Already per-capability (`ProviderCapabilityRecord.maturity`) with `effectiveMaturity = min(provider, capability)`. Ladder is `verified > sandbox > experimental > disabled`. Section 8 maps this onto the five requested public states without weakening the gate. |
| Base treasury | `0x0e79371813e88F31c2B60C80bad391a952039095` — **2.85 USDC**, 0.001026 ETH. Daily limit 2 USDC, min balance 0.50 USDC. Funded and usable. |
| Solana treasury | **No key.** `CONSUMER_TREASURY_SOLANA_SECRET_KEY` unset locally and on Railway. |
| Tempo treasury | **No key**, and no executable MPP client. |
| Production flags | `CONSUMER_PACK_ENABLED=true`, `CONSUMER_EXECUTION_ENABLED=true`, `CONSUMER_AUTH_REQUIRED=1`, `CONSUMER_LIVE_SMOKE_ENABLED=false`, `CONSUMER_MAX_SINGLE_EXECUTION=1.00`. |
| Production provider states | `stabledomains` **verified** (`domains.check` verified, rest sandbox/experimental); `stableemail` sandbox; `stabletravel` sandbox; `purch` experimental; `stablemerch` experimental. |

---

## 1. Non-negotiables carried from the brief

- Reuse: request → Consumer Intent → deterministic policy → exact approval → reservation/funding
  → provider settlement → delivery verification → ledger reconciliation → Untch receipt.
- One provider at a time. A provider is not "done" until it has a real live payment where required,
  a real delivered result, delivery verification, balanced ledger entries, a non-null receipt,
  production smoke evidence, and an explicit maturity state.
- Production stays on Railway. Nothing goes to EC2.
- Personal data (email bodies and recipients, shipping addresses, registrant identity, traveller
  identity) never enters a public receipt. Hashes only.
- Pause and ask before: the first irreversible physical purchase, the first domain registration,
  the first paid travel booking.
- No `Co-authored-by` trailers.

---

## 2. Maturity vocabulary

The internal ladder is the execution gate and does not change — `assertExecutable` still refuses
anything below `verified`. A **public** five-state label is derived from it, per tool:

| Internal `effectiveMaturity` | `accessBlocker` | Public state |
| --- | --- | --- |
| `verified` | — | **LIVE** |
| `sandbox` | — | **BETA** |
| `experimental` | `null` | **SANDBOX** |
| `experimental` | `PARTNER_ACCESS` / `IDENTITY_REQUIRED` / `RAIL_UNAVAILABLE` | **PARTNER_ACCESS_REQUIRED** |
| `disabled` | — | **DISABLED** |

`accessBlocker` is a new, additive, nullable field on `ProviderCapabilityRecord`. It names *why* a
tool is stuck, so "we haven't finished it" is never presented as "the provider won't let us".
Derivation is a pure function so registry, `/consumer/catalog`, dashboard, docs and the OKX.AI
draft all read the same answer.

---

## 3. Untch Mail (StableEmail) — first

Contract read live from `https://stableemail.dev/llms.txt` on 2026-07-29.

| Tool | Endpoint | Price | Protection | Target state |
| --- | --- | --- | --- | --- |
| `mail.send` | `POST /api/send` | $0.02 | x402 (Base/Solana/Tempo) | **LIVE** after real delivery |
| `mail.inbox.buy` | `POST /api/inbox/buy` | $1.00 | x402 | BETA |
| `mail.inbox.status` | `GET /api/inbox/status` | free | SIWX | BETA (needs SIWX key) |
| `mail.inbox.topup` | `POST /api/inbox/topup` | $1.00 | x402 | BETA |
| `mail.inbox.cancel` | `POST /api/inbox/cancel` | free | SIWX | BETA (pro-rata refund on-chain) |
| `mail.subdomain.buy` | `POST /api/subdomain/buy` | $5.00 | x402 | BETA |
| `mail.subdomain.status` | `GET /api/subdomain/status` | free | SIWX | BETA |
| `mail.subdomain.send` | `POST /api/subdomain/send` | $0.005 | x402 | BETA |

### First live proof (mail.send)

1. Consumer Intent created for `mail.send`.
2. Deterministic policy checks recipient, subject, cost and provider.
3. Real 402 challenge read from `POST /api/send` — no invented price.
4. Base treasury pays the challenge; recipient asserted equal to the verified StableEmail payTo
   `0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671`.
5. Real `messageId` returned.
6. Delivery confirmed to a user-controlled inbox.
7. Receipt records the provider payment and the **hash** of the messageId and subject — never the
   body, never the recipient list.
8. Ledger reconciles and the user-obligation account nets to zero.
9. `receiptId` non-null.

Only after a confirmed delivery does `mail.send` become LIVE. `inbox` and `subdomain` flows are
activated separately, after that.

**Independent verification note.** `mail.send` on the shared relay exposes no per-message status
endpoint, so Untch cannot self-verify delivery from the sender side; today the adapter honestly
reports `untchVerified: false, method: NONE`. The `mail.inbox.*` tools change that — an
Untch-owned inbox with `retainMessages` can be read back over the API — so the second Mail
milestone upgrades `mail.send` verification from provider-attestation to a real round-trip.

---

## 4. Untch Shop & Gifts (Purch) — second

Purch settles **only** on Solana USDC. Every Purch call today ends at `PROTOCOL_NOT_EXECUTABLE`
because `X402SolanaExactClient` is a stub. So the work is the rail, not the adapter:

- dedicated Solana treasury key (`CONSUMER_TREASURY_SOLANA_SECRET_KEY`), never shared with Base
- USDC mint allowlist (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
- RPC configuration + SOL gas monitoring
- per-execution cap, daily cap, provider recipient allowlist
- transaction confirmation, ambiguous-status recovery, no blind retries
- the official x402 Solana `exact` payload as the provider returns it — not guessed

Activation order: paid product search → paid gift recommendation → low-value digital result →
physical purchase (explicit approval, bound to item/URL/merchant/quantity/item amount/shipping/
tax/total/delivery-address hash/quote expiry/cancellation terms, shipping encrypted).

**PAUSE POINT** before the first irreversible physical purchase.

---

## 5. Untch Domains (StableDomains) — third

`domains.check` stays LIVE. Add `domains.quote`, `domains.register`, `domains.status`,
`domains.renew`, `domains.dns.read`, `domains.dns.update`.

Provider identity becomes explicit workflow states, not implicit preconditions:
`AWAITING_PROFILE → AWAITING_SIWX → AWAITING_EMAIL_OTP → IDENTITY_VERIFIED → QUOTE_READY →
AWAITING_APPROVAL → READY_FOR_PAYMENT`. SIWX, OTP and the registrant profile are never bypassed.
Registrant information is encrypted and never appears in a public receipt.

**PAUSE POINT** before buying the first domain. Ownership is then verified through RDAP.

---

## 6. Untch Travel — fourth

Probe the live `https://trips.sh/skill.md` contract; keep the existing StableTravel adapter, which
is a flight **data** provider (its own OpenAPI states it does not issue tickets, hold reservations
or take payment). Build provider-neutral `travel.search`, `travel.compare`, `travel.quote`,
`travel.book`, `travel.status`, `travel.cancel`, `travel.refund_status`, and record per provider
which of those is genuinely supported. Search is never described as booking. Booking stays
PARTNER_ACCESS_REQUIRED until a real reservation reference comes back.

**PAUSE POINT** before the first paid booking.

---

## 7. Consumer Sessions — fifth

A new durable object: owner, authorised agents, funded/remaining amounts, total/daily/per-action
caps, category + provider + recipient allowlists, auto-approval and escalation thresholds, max
action count, expiry, pause/revoke/close, refund destination, full transaction history.

Tools: `session.create`, `session.fund`, `session.status`, `session.pause`, `session.resume`,
`session.reduce_authority`, `session.close`, `session.refund`, `session.transactions`.

One session works across Mail, Domains, Shop & Gifts and Travel. A session **never** removes the
exact-approval requirement for physical purchases, domain registrations, travel bookings, or
anything outside its configured thresholds.

---

## 8. Order of work and stop rule

1. Mail — `mail.send` live on Base. **← current**
2. Mail — inbox + subdomain tools.
3. Purch — Solana rail, then paid search/gift.
4. Domains — full flow to the approval gate.
5. Travel — probe, then search/compare/quote.
6. Consumer Sessions.
7. Per-tool maturity surfaced everywhere; OKX.AI registration package.

Each step ends with: tests, typecheck, web/docs build, CI, Railway deploy, health check, and an
evidence file under `internal/evidence/consumer-pack/`. Anything not proven is reported as not
proven.

---

## 9. Known blockers at plan time

- **X Layer receipt-writer proposal is in its three-day timelock.** Mainnet receipt anchoring is a
  scheduled maintenance action for 2026-07-31 after 11:46:46 UTC. Not polled, not waited on. New
  Mail and Purch receipts are re-driven and anchored after activation.
- **No Solana key anywhere.** Purch cannot settle until one exists and is funded.
- **No `CONSUMER_SIWX_PRIVATE_KEY`.** Every SIWX-gated tool (inbox status, subdomain management,
  StableMerch, StableDomains DNS) reports `PROVIDER_UNAUTHORIZED` until one is configured.
- **No Tempo rail.** MPP challenges are parsed, never executed.
- Base treasury holds 2.85 USDC. Enough for Mail; not enough for a $20 domain registration or a
  $5 subdomain plus headroom.
