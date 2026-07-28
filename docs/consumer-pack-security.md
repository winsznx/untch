# Consumer Pack security

The threat model, and where each control actually lives. A control that lives only in a comment is
not a control, so every row below names a file, a constraint, or a test.

## Custodial boundary — say it first

**Between `FUNDED` and `COMPLETED`, Untch holds the user's value as an operator.** This is a
custodial ledger. It is not trustless, and nothing in this pack should be described as trustless.

The controls below make that custody *accountable* — append-only double entry, capability-scoped
spending, kill switches, reconciliation. They do not make it *non-custodial*. That needs a
`ConsumerEscrow` contract, and `UntchVault` cannot stand in (no per-intent lock, no refund path; its
only exit is the unconditional `ownerWithdraw` escape hatch). See
[treasury-routing.md](./treasury-routing.md#the-custodial-boundary-stated-plainly).

## The matrix

| Threat | Control | Where |
|---|---|---|
| **Payment replay** | x402 nonce + `validBefore` in every authorization; a captured signature expires on its own | `x402/evm-exact.ts` |
| | one on-chain payment can never be counted twice | `UNIQUE (chain, lower(tx_hash))` on `consumer_funding_receipts` |
| **One receipt funding two intents** | `intent_id` is the PRIMARY KEY of the funding table | migration 007 |
| **Quote tampering** | `quoteHash` over the canonical quote; the approval stores it; execution re-checks it | `assertApprovalStillBinds` |
| **Policy substitution** | the approval stores `policy_id`, `policy_version` AND `policy_hash`; a changed policy invalidates it | same, asserted in the e2e suite |
| **Approval substitution** | `UNIQUE (intent_id)` on approvals; `pollRef` is derived, never supplied | migration 007 |
| **Duplicate execution** | `UNIQUE (provider_id, idempotency_key)` + CAS transition + single-use capability + `UNIQUE (intent_id, kind)` on ledger groups | migration 007 |
| **Underpayment** | funding below the authorised amount is refused; the intent stays `AWAITING_FUNDING` | `confirmFunding` |
| **Wrong token / wrong chain** | settlement allowlist checked FIRST during selection; an unconfirmed asset is excluded by construction | `assets.ts`, `x402/challenge.ts` |
| **Wrong recipient** | capability allowlist, re-checked inside `pay()`; the challenge's `payTo` must equal the approved recipient | `treasury.ts` |
| **Signing for a different token** | the EIP-3009 domain is taken from the challenge and cross-checked against the registry; a mismatch is refused, not signed | `eip3009DomainFor` |
| **Paying something the provider did not ask for** | the signer re-checks amount + recipient against the CHALLENGE, not just the capability | `X402EvmExactClient.pay` |
| **Provider webhook forgery** | signed webhooks only; unsigned inbound is ignored | `events.ts` |
| **Malicious provider responses** | every response parsed by a runtime validator before it becomes a domain object; unknown fields dropped | `schema.ts` |
| **Prompt injection in product text** | provider text is DATA. The control plane is LLM-free (I1), so a product titled as a prompt is just an oddly-named product. Text is sanitized of control characters at the boundary so it cannot reach an operator's terminal as ANSI escapes | `sanitizeProviderText` |
| **SSRF** | base URLs come from `consumer_providers.base_url` only, never from a request; every resolved IP is checked against loopback / RFC1918 / link-local (incl. `169.254.169.254`) / CGNAT / multicast before connecting; https only; URL credentials refused | `http.ts`, 19 blocked-range assertions |
| **Redirect to an unagreed host** | `redirect: "manual"`, a 3xx is a typed refusal | `http.ts` |
| **Response flooding** | body capped by counting bytes, not by trusting `content-length` | `readCapped` |
| **Log injection / data leak** | one redactor: addresses shortened, bodies dropped, header/key names allowlisted or dropped by NAME so an unrecognised secret format is still caught | `redactForLog` |
| **Cross-tenant idempotency collision** | `PRIMARY KEY (tenant_id, key)`, and the derivation folds the tenant in too — impossible at both layers | migration 007, `ids.ts` |
| **Cross-tenant read** | `getIntentForTenant` is a WHERE clause, not a post-read comparison; the tenant is derived from the policy id, not declared by the caller | `repo-pg.ts`, `handlers.ts` |
| **Chain reorgs** | the ONE backward edge, `FUNDED → AWAITING_FUNDING`, is legal because nothing has been spent yet | `state.ts` |
| **Stale quotes** | checked at approval AND again immediately before provider payment | `assertQuoteFresh` |
| **Precision errors** | integer atomic units end to end; `parseMoney` REJECTS more fractional digits than the asset holds; no `number` ever holds money | `money.ts` |
| **Unlimited token approvals** | EIP-3009 authorises an exact amount to an exact recipient — no ERC-20 `approve` is ever issued | by construction |
| **Compromised adapter** | capability scoping: one intent's authorised amount, to one allowlisted recipient, once | `treasury.ts` |
| **Treasury depletion** | per-provider per-tx and daily caps, per-account daily limit, minimum float floor, low-balance alerts | `TreasuryRouter` |
| **A discovery call draining purchase authority** | reads get their own cents-scale capability | `AdapterContext.discoveryPayment` |
| **Admin endpoint abuse** | operator surfaces behind the existing SIWE session + §27 ownership check | `apps/web/lib/auth` |
| **Ambiguous outcome retried** | `retryable && sideEffectPossible` is rejected at construction; the reconciler QUERIES, never re-sends | `errors.ts`, `reconcileAmbiguous` |
| **Executing an unproven provider** | maturity ladder; the escape hatch reaches one rung and is stamped on the intent | `ProviderRegistry` |
| **Global compromise** | five-scope kill switch, checked before a capability is minted | `firstEngagedPause` |

## Three controls worth expanding

### The paid retry is where ambiguity is born

Once the payment header leaves, the merchant may act on it whether or not we see the response. Any
transport failure on the paid retry is classified `PAYMENT_AMBIGUOUS` with `retryable: false` and
`sideEffectPossible: true`, which sends the intent to `MANUAL_REVIEW` with the money in `SUSPENSE`.

This is the single most consequential classification in the system, and it is asserted directly.

### An empty `accepts[]` is not a payment failure

StableMerch's catalog, StableMerch's drafts and StableDomains' DNS all answer 402 with an empty
`accepts[]` plus a `sign-in-with-x` extension. That is authentication. A client that treats it as "no
acceptable rail" sends an operator hunting for a treasury problem that does not exist; one that loops
on it never terminates. `classifyChallenge` makes the call once.

### The SIWX key is powerless on purpose

`CONSUMER_SIWX_PRIVATE_KEY` proves *who is asking*. It holds no funds and authorises no spend, and it
must be a different key from every treasury key. Untch's own dashboard already separates SIWE
identity from spending authority; this is the same posture pointed outward.

## What is NOT protected

Stated so nobody assumes otherwise.

1. **DNS rebinding between resolution and connection.** `assertFetchable` resolves and checks every
   address before the request, but a TOCTOU window remains. Closing it needs a pinned socket.
2. **A malicious verified provider.** A merchant that takes payment and does not deliver is a
   dispute, not a bug. The controls bound the *amount* (per-tx cap, daily cap, float floor) and make
   the evidence available; they do not make the merchant honest.
3. **Physical delivery.** Untch verifies that an order was placed and paid. It does not verify that a
   parcel arrived, and `verifyDelivery` says so rather than implying more.
4. **Operator key compromise.** A stolen treasury key drains that rail's float up to its balance. The
   mitigations are the floor, the daily limit and the kill switch — not prevention.
5. **The custodial gap** (see the top of this document).

## Reporting

Security issues in the Consumer Pack: the same channel as the rest of Untch. Do not open a public
issue for anything touching the treasury, the funding leg, or the approval binding.
