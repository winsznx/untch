# Public copy drafts — X, YouTube, HackQuest

**Date:** 2026-07-28
**Source of truth:** `internal/public-claims-matrix.md`

Paste-ready. Every sentence here is checkable by someone who does not trust us, and the two maturity
boundaries appear in each one. **Do not remove them to make the copy punchier** — a claim that
survives only because nobody checked is a liability, and a boundary you published yourself is far
cheaper than one a judge finds.

Both boundaries retire automatically when the underlying fact changes; the retirement conditions are
in the claims matrix addendum.

---

## 1. X / Twitter article

> ### The model never touches the money
>
> You want to fund an agent. You do not want to find out afterwards that it bought the same thing
> eleven times, paid a vendor that never delivered, or drained a wallet because a prompt told it to.
>
> Today the only real control is the balance in the wallet. That is not a control. It is a blast
> radius.
>
> **Untch is a deterministic authority layer that decides whether an agent is allowed to spend,
> before any money moves.**
>
> Fourteen rules over a bounded spend intent — budget, per-call cap, category, recipient, duplicate,
> cooldown, rate limit, expiry. **No LLM call appears anywhere on the money decision path.** The
> engine is a pure function of the intent, the policy and the ledger window, so the same inputs
> always produce the same decision, and anyone can re-derive it.
>
> An approval binds to a **hash**, not a description. Change the amount, the recipient, the item or
> the deadline and the hash changes, so the approval stops applying. There is no path where a human
> approves $5 and $500 leaves.
>
> **What we actually did in production:**
>
> Untch completed real production-governed provider settlements in Base USDC, independently verified
> the delivered domain result through public RDAP data, and generated durable Consumer Pack receipts.
>
> Two transactions, 0.050000 USDC each, paid to StableDomains' own address on Base — the merchant's
> rail, not ours. The second was executed end to end by the deployed worker with no script involved:
>
> `0x6815d60e1be688451d36007a4113f858e0a10433dccef01dc3b3d0f8d283e489`
>
> Delivery was checked against **public RDAP** — the domain registry itself, not the merchant's own
> response. The receipt reports what the merchant claimed and what Untch independently confirmed as
> two separate fields, and never merges them.
>
> **Where the boundary is, stated by us rather than found by you:**
>
> Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury.
>
> Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt
> anchoring is pending writer activation through the contract's three-day timelock.
>
> One consumer capability is verified and can move money: domain availability checking. Domain
> registration, shopping, gift ordering, travel booking and notifications are implemented, gated, and
> **refuse with a named reason**. The live capability matrix is a public endpoint, so you can check
> that claim against the machine instead of against me:
> `asp.untch.xyz/consumer/catalog`
>
> Untch is custodial between funding and completion. It is not trustless, and the documentation says
> so.
>
> Open a receipt yourself, no account needed:
> `untch.xyz/receipt/ci_82bb2216c02366bc1b839a00`
>
> OKX.AI ASP #6086 · ERC-8004 agent #6047 · github.com/winsznx/untch

---

## 2. YouTube description

```
Untch — deterministic authority for autonomous agent spend.

An agent proposes. A deterministic policy engine decides. The model never touches the money.

Fourteen rules over a bounded spend intent, evaluated in a fixed order. No LLM call appears anywhere
on the money decision path — the engine is a pure function of the intent, the policy and the ledger
window. An approval binds to a hash, so mutating the intent invalidates it.

WHAT IS ACTUALLY PROVEN IN PRODUCTION
Untch completed real production-governed provider settlements in Base USDC, independently verified
the delivered domain result through public RDAP data, and generated durable Consumer Pack receipts.

Base settlement (executed by the deployed worker):
https://basescan.org/tx/0x6815d60e1be688451d36007a4113f858e0a10433dccef01dc3b3d0f8d283e489

Public receipt, no account required:
https://untch.xyz/receipt/ci_82bb2216c02366bc1b839a00

CURRENT MATURITY — published, not hidden
Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury.
Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt
anchoring is pending writer activation through the contract's three-day timelock.
One verified consumer capability (domain availability checking). Domain registration, shopping,
gifts, travel booking and notifications are gated and refuse with a named reason.
Untch is custodial between funding and completion. Not trustless.

LINKS
Site           https://untch.xyz
Docs           https://docs.untch.xyz
Proof page     https://docs.untch.xyz/consumer-pack-proof
Live catalog   https://asp.untch.xyz/consumer/catalog
Changelog      https://untch.xyz/changelog
Source         https://github.com/winsznx/untch
OKX.AI         ASP #6086 · ERC-8004 agent #6047

X Layer mainnet contracts
PolicyRegistry       0xa2177e6d8682367637a3c2af53e2cf8088efa954
SpendIntentRegistry  0x9c1f89dfddd9ae1f9adda4b30ff338e2aa2db202
UntchReceipts        0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95
VaultFactory         0x6cc3bc686a7bc554dbd5636cb3eeee9171036805

Chapters
00:00 The problem: a balance is not a control
00:00 Deterministic policy — no LLM on the money path
00:00 Exact approvals and mutation rejection
00:00 Paying a merchant on the merchant's own rail
00:00 Independent delivery verification via RDAP
00:00 Public receipts and honest anchor states
00:00 Where the boundary is today
```

*(Set the chapter timestamps from the final cut.)*

---

## 3. HackQuest submission

**One-liner**

> Untch is a deterministic authority layer that decides whether an autonomous agent is allowed to
> spend, before any money moves — and proves the decision on-chain afterwards.

**What it does**

> Any agent can propose a real-world action. Untch decides whether it is authorised against fourteen
> deterministic rules, asks a human when policy says to, funds it for the exact approved amount, pays
> the merchant on the merchant's own rail, verifies delivery against a source that is not the
> merchant, and produces one receipt spanning both payments.
>
> No LLM call appears anywhere on the money decision path. The engine is a pure function of the
> intent, the policy and the ledger window.

**What is proven in production**

> Untch completed real production-governed provider settlements in Base USDC, independently verified
> the delivered domain result through public RDAP data, and generated durable Consumer Pack receipts.
>
> Two settled transactions of 0.050000 USDC each to StableDomains on Base, the second executed end to
> end by the deployed worker. Delivery verified against public RDAP. The double-entry ledger sums to
> exactly zero on both rails.
>
> 677 tests, zero failures. Seven CI workflows green. Mandatory SIWE ownership authentication live in
> production, verified by a 14-case attack matrix run against the live endpoint with real signatures.

**Current maturity — stated openly**

> Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury.
>
> Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt
> anchoring is pending writer activation through the contract's three-day timelock.
>
> One consumer capability is verified and can move money: domain availability checking. Domain
> registration, shopping, gift ordering, travel booking, notifications, Solana settlement and Tempo
> settlement are implemented, gated, and refuse with a named reason. The live capability matrix is
> public at `asp.untch.xyz/consumer/catalog`.
>
> Untch is custodial between funding and completion. It is not trustless.

**Tech stack**

> TypeScript · Next.js · Postgres · Redis · Solidity (Foundry) · viem · x402 v2 · EIP-3009 · SIWE ·
> X Layer · Base

**Links**

> Live: https://untch.xyz · Docs: https://docs.untch.xyz/consumer-pack-proof ·
> Source: https://github.com/winsznx/untch · OKX.AI ASP #6086 · ERC-8004 agent #6047

---

## 4. Edits required when a boundary retires

**When the external-funder proof completes** — replace every occurrence of:

> Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury.

with:

> Consumer Intents can be funded by an external wallet; Untch settles with the provider from its own
> treasury. Both legs are recorded separately in the double-entry ledger.

**When mainnet writer activation completes** *(only once `isWriter` returns `true` **and** a re-driven
receipt is `CONFIRMED` with a tx whose `to` is the mainnet `UntchReceipts`)* — replace:

> Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt
> anchoring is pending writer activation through the contract's three-day timelock.

with:

> Receipts are anchored on X Layer mainnet.

Surfaces to update in both cases: this file, `README.md`, `apps/web/app/changelog/page.tsx`,
`docs/consumer-pack-proof.mdx`, `internal/public-claims-matrix.md`,
`internal/okx-ai-consumer-pack-reregistration.md`, and wherever the X / YouTube / HackQuest copy has
been published.
