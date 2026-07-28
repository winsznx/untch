# OKX.AI service registration draft — Untch Consumer Pack

Six A2MCP services to add under the existing **Untch** ASP (ERC-8004 agent 6047, marketplace ASP
6086). No new listing, no second identity, no new review cycle for the ASP itself.

**Read this section before submitting anything.** The maturity table below is the honest state, and
the registration copy must not outrun it.

---

## Registration readiness — what is TRUE today

| Service | Register now? | Why |
|---|---|---|
| **Untch Consumer Status** | **Yes** | Free, read-only, fully working. No provider dependency. |
| **Untch Domains** (check/quote) | **Yes** | Discovery + a bindable quote from StableDomains' own live 402. Works today. |
| **Untch Travel** (search/compare) | **Yes** | Live Google Flights fares via StableTravel. Works today. |
| **Untch Domains** (register/renew) | **Not yet** | Needs a funded Base USDC float AND one verified settlement. |
| **Untch Shop** | **Not yet** | Purch settles only on Solana, and that rail is not executable in this build. |
| **Untch Gifts** | **Not yet** | StableMerch is SIWX-gated; the identity leg is unproven. |
| **Untch Consumer Notify** | **Not yet** | Needs a funded Base USDC float AND one verified settlement. |

Registering a service whose execute route returns `PROVIDER_NOT_EXECUTABLE` would be a listing that
takes a fee and cannot deliver. **Register the three that work; add the rest as each provider is
promoted.**

---

## Service 1 — Untch Consumer Status  *(register now)*

**Name:** Untch Consumer Status
**Type:** A2MCP · **Price:** free
**Endpoint:** `GET https://asp.untch.xyz/consumer/intent/{intentId}`

> Track any governed consumer action Untch is running for you: current state, what the user funded,
> what the merchant was paid, the delivery evidence, and the final cross-rail receipt. Also serves a
> live event stream with resume, so an agent can watch a purchase without polling.

Also exposes `/payment`, `/delivery`, `/receipt` and `/events` (SSE with `Last-Event-ID`).

The delivery surface reports the merchant's claim and Untch's independent verification as two
separate fields, never merged.

---

## Service 2 — Untch Domains  *(register the check/quote half now)*

**Name:** Untch Domains
**Type:** A2MCP · **Price:** $0.02 check · $0.05 quote
**Endpoint:** `POST https://asp.untch.xyz/consumer/domains/check`

> Check a domain across 28 TLDs and get a bindable registration quote — the registrar's own exact
> price, plus Untch's disclosed fee and cross-rail spread, with a TTL. Every quote runs through a
> deterministic spend policy before anything can be funded.

**Do not claim registration yet.** When the Base float is funded and one settlement is verified, add
`register` and `renew` and the copy becomes: *"…and register it under a policy your agent cannot
exceed."*

Input `{ policyId, ref }`. Output carries the quote, the engine's decision verbatim, and either a
funding request or an approval-pending state.

---

## Service 3 — Untch Travel  *(register the search/compare half now)*

**Name:** Untch Travel
**Type:** A2MCP · **Price:** $0.03 search · $0.02 compare
**Endpoint:** `POST https://asp.untch.xyz/consumer/travel/search`

> Live cash fares with price insights, and the airline and OTA links that actually book them —
> governed, budgeted, and receipted.

**Say "search and compare", never "book".** The integrated provider is explicit that it "does not
issue tickets, hold reservations, or take payment for travel". The `book` route exists as a typed
contract and returns `501 CAPABILITY_UNAVAILABLE` until a booking provider is integrated.

---

## Services 4–6 — hold until the provider is promoted

**Untch Shop** — $0.02 search · $0.05 quote · $0.05 purchase.
Blocked on the Solana x402 rail: the payload serialization could not be confirmed from an
authoritative source, and Purch offers no Base alternative in any of its challenges.

**Untch Gifts** — $0.05 quote · $0.05 order.
Blocked on SIWX: four of StableMerch's five steps need a wallet identity, and the EIP-4361 rendering
this build produces has never been accepted by their verifier.

**Untch Consumer Notify** — $0.03 per send.
Blocked only on a funded Base float. This is the cheapest of the three to unblock.

---

## The listing copy that is true regardless

Use this as the ASP-level description of the Consumer Pack. Every sentence is defensible today.

> **Untch is the authority layer for what an agent is allowed to actually do.**
>
> Any agent can search, compare and propose. Untch decides whether the action is permitted, asks a
> human when the policy says to, funds it for the exact approved amount, pays the merchant on the
> merchant's own rail, verifies delivery where that can be verified, and produces one receipt that
> spans both payments.
>
> The merchants are replaceable. The boundary is not.

**Three claims worth making, because they are unusual and true:**

1. **The purchase value is separate from the call fee.** The marketplace price is Untch's
   orchestration fee. The variable amount — whatever a domain or a product costs — is funded on its
   own leg, priced per-intent, for exactly the amount a policy authorised.
2. **An ambiguous outcome goes to a human, never to a retry.** If a request leaves Untch and its
   response is lost, the merchant may have acted. Untch parks the money in a suspense account and
   asks. Resending would be a possible second purchase.
3. **What the merchant says and what Untch proved are reported separately.** A receipt never presents
   a merchant's assertion as an independent verification.

**Claims to avoid:**

- Anything implying a provider is live before it has settled.
- "Book flights" — the integrated travel provider does not sell inventory.
- "Trustless" — between funding and completion, Untch holds the value as an operator. It is a
  custodial ledger and the documentation says so.

---

## Pre-submission checklist

- [ ] `https://asp.untch.xyz/consumer/catalog` returns 200 and lists real maturity per provider
- [ ] Each registered endpoint 402s correctly when unpaid, with `resource.url` on **https**
      (the `trust proxy` fix in `edbfb64` — re-verify after deploy)
- [ ] `GET /agent-registration.json` still renders (ERC-8004 card unchanged)
- [ ] Every registered service's execute path either works or is not registered
- [ ] Migration `007_consumer_pack.sql` applied to the production database
- [ ] `CONSUMER_ALLOW_SANDBOX_EXECUTION` is **unset** in production
- [ ] Existing services (`ping_untch`, `preflight_payment`, `verify_delivery`, the Bureau and report
      tools) unchanged and still passing

---

## Demo for reviewers

`pnpm consumer:demo` prints one complete governed transaction — quote from the merchant's own price
challenge, real policy decision, exact-amount funding leg, cross-rail settlement, delivery evidence,
balanced ledger, full event stream. It names its two fakes on stdout (the provider's HTTP responses,
replayed from a real captured 402, and the settlement signature) and runs the production code path
for everything else.

`--escalate`, `--blocked` and `--ambiguous` show the human-approval, policy-block and
manual-review paths.
