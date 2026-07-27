# Untch Consumer Pack

Governed execution of real-world consumer actions: shopping, domains, travel, gifts and
transactional notifications.

The provider catalogue is not the product. Untch's value is the authority boundary around those
actions — bounded intent, deterministic policy, exact approval, controlled execution, verified
delivery, and one receipt that spans both payment rails. The merchants are replaceable. The boundary
is not.

---

## The one-paragraph version

An agent proposes a real-world action. Untch turns it into a **Consumer Intent** — one durable,
state-machined record. It gets an exact quote from the merchant's own price challenge, evaluates it
with the same deterministic policy engine that governs every other Untch spend, escalates to a human
when the policy says so, asks the caller to fund **exactly** the authorised amount on a separate leg,
pays the merchant from a pre-funded float on the merchant's own rail, verifies delivery
independently where that is possible, and closes with a receipt that shows both legs.

---

## What is actually shipping

| Capability | Status |
|---|---|
| Consumer Intent state machine (22 states, centrally validated) | **working** |
| Deterministic policy evaluation via the existing §7.1 engine | **working** |
| Human approval via the existing §7.2 / §27 escalation pipeline | **working** |
| Exact-amount funding leg (x402 `DynamicPrice`) | **working** |
| Double-entry, append-only ledger | **working** |
| Capability-scoped treasury (adapters never see a key) | **working** |
| Transactional outbox + SSE with `Last-Event-ID` resume | **working** |
| Base USDC settlement (x402 `exact`, EIP-3009) | **implemented, never settled live** |
| Solana USDC settlement | **not executable** — payload shape unconfirmed |
| Tempo / MPP settlement | **not executable** — currency encoding unconfirmed |
| Any provider at maturity `verified` | **none** |

**No provider can execute today.** That is a factual consequence of the maturity ladder, not a bug:
promotion to `verified` requires a real settled payment from an Untch treasury wallet, and no
treasury key exists in any Untch environment. Discovery and quoting work; every execute route refuses
with a named reason. See [the runbook](./consumer-pack-runbook.md#promoting-a-provider-to-verified).

---

## The public surface

Six A2MCP services, all under the existing Untch ASP. Narrow, typed tools — never one untyped action
endpoint.

**Untch Shop** — `POST /consumer/shop/{search,quote,purchase}`, `GET /consumer/shop/order/:intentId`
**Untch Domains** — `POST /consumer/domains/{check,quote,register,renew}`, `GET …/status/:intentId`
**Untch Travel** — `POST /consumer/travel/{search,compare,quote,book}`, `GET …/booking/:intentId`
**Untch Gifts** — `POST /consumer/gifts/{quote,order}`, `GET …/status/:intentId`
**Untch Consumer Status** — `GET /consumer/intent/:intentId{,/payment,/delivery,/receipt,/events}`
**Untch Consumer Notify** — `POST /consumer/notify/{confirmation,receipt,exception}`

Plus `GET /consumer/catalog` (free) and `POST /consumer/fund/:intentId` (the variable-value leg).

Full request and response shapes: [consumer-pack-api.md](./consumer-pack-api.md).

---

## The two-price rule

This is the design decision the whole pack turns on.

The **fixed** route price — `$0.02` for a search, `$0.05` for a quote — is Untch's orchestration fee,
paid through the OKX marketplace's x402 rail on X Layer. It is what an agent pays Untch.

The **variable** purchase value — $20.00 for a domain, whatever a product costs — is a completely
separate leg, funded per-intent at `POST /consumer/fund/:intentId`.

Conflating them would mean either charging every caller the maximum a purchase might cost, or
settling purchases out of a fee. Both are worse than an extra round trip.

The mechanism is `DynamicPrice`, which the installed `@okxweb3/x402-core@0.1.0` supports
(`x402HTTPResourceServer-BqdilVCp.d.ts:59,90` — verified in the type declarations, not assumed):

```ts
type DynamicPrice = (context: HTTPRequestContext) => Price | Promise<Price>
type Price = string | number | { asset, amount, extra? }
```

The route is registered once with a price *function*. The function reads the intent id out of the
request path, loads the intent, and returns its exact authorised atomic amount. Five conditions each
**throw** rather than returning a fallback — unknown intent, wrong state, already funded, expired
window, stale quote — because a fallback price would make exactly those cases payable.

---

## Architecture

```
packages/consumer-core/       @untch/consumer-core
  money · assets · state machine · double-entry ledger · treasury router ·
  provider registry · outbox + SSE framing · Postgres store (migration 007)
  → no HTTP, no keys. Testable with neither.

packages/consumer-providers/  @untch/consumer-providers
  hardened fetch · runtime validators · x402 / MPP / SIWX clients ·
  the typed adapter contract · five merchant adapters

services/asp/src/consumer/
  projection (Consumer Intent → §8.1 SpendIntent) · orchestrator · bridges ·
  funding price · outbox dispatcher + SSE hub · handlers · routes · wiring

apps/web/app/dashboard/consumer/
  overview · intent detail · treasury · provider registry · manual review
```

### What it reuses rather than reinvents

| Need | Reused |
|---|---|
| Policy evaluation | `@untch/policy-engine` — the same 13 §7.1 rules, unchanged |
| Policy storage and binding | `@untch/policy-store` |
| Canonical intent hash | `@untch/canon` |
| Human approval | `@untch/escalation` — same `pollRef`, same §27 boundary, same 5 channels |
| Receipts and anchoring | `@untch/receipt-writer` |
| Postgres pool + migrations | the shared `db.ts` shape and advisory lock |
| Chain/token registry | `packages/shared/src/chains.ts`, extended |
| Inbound x402 | `@okxweb3/x402-express`, already wired |
| Challenge binding | `@untch/x402-guard` |

A consumer action is *projected* onto a §8.1 `SpendIntent`, so the existing engine governs a domain
registration for the same reason it governs an A2MCP call. There is no second policy path.

---

## Documentation map

- [consumer-intent-lifecycle.md](./consumer-intent-lifecycle.md) — the 22 states and every edge
- [treasury-routing.md](./treasury-routing.md) — floats, capabilities, limits, reconciliation
- [provider-adapters.md](./provider-adapters.md) — the adapter contract, maturity, onboarding
- [consumer-pack-security.md](./consumer-pack-security.md) — the threat model
- [consumer-pack-runbook.md](./consumer-pack-runbook.md) — every operational procedure
- [consumer-pack-api.md](./consumer-pack-api.md) — the wire contract
- `internal/consumer-pack-implementation-plan.md` — the grounded build plan and provider matrix
- `internal/consumer-pack-evidence/` — the raw 402 captures every claim rests on
