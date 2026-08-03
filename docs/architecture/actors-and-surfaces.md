# Actors and surfaces

**Status:** current as of 2026-08-04, after the first paid direct-account V3 decision.
Everything below is either LIVE or explicitly marked as not built. Nothing here is aspirational.

---

## The one sentence

> **The human owns the authority. The agent invokes the control. The wallet signs only after the
> required authority exists.**

Untch is not a wallet and not a custodian. It decides whether a proposed spend is permitted, records
why, and reserves the capacity — and it does that for money it never holds.

---

## Three product surfaces

These are related and genuinely distinct. Conflating them is what made the earlier documentation
describe one product when there are three.

### Untch Control — used by the human

The account owner creates and governs. They do not hand-write preflight requests.

```
create an Untch account
→ link an Agentic Wallet (SIWE)
→ register or select a policy
→ set budgets, caps, escalation thresholds, allowed recipients and categories
→ link approval channels
→ review activity, receipts and exceptions
```

The questions this surface answers: *which agents may spend · what may they buy · how much · which
recipients · when should I be asked · what proof must arrive before settlement counts as complete.*

### Untch Guard — called by the user's own agent

The agent is about to do something that involves money. Before it does, it asks.

```
agent builds a request
→ Untch resolves the account, the wallet authority and the exact policy
→ deterministic rules evaluate
→ APPROVED | ESCALATED | BLOCKED
→ on approval the agent receives authority bound to that exact request
```

Not an open-ended yes. The approval binds an intent hash and a quote digest; change the amount, the
recipient or the terms and it authorises nothing.

### Untch Services — bought by other agents

Untch acting as an ASP: `preflight_payment`, `verify_delivery`, the Consumer Pack tools, owned work.
Reached over A2MCP today.

```
The human buys Untch Control.
The agent invokes Untch Guard.
Other agents buy Untch Services.
```

---

## The actors

| Actor | What it is | What it may do |
| --- | --- | --- |
| **Human account owner** | The person who owns the money and defines authority | Creates the account and policies; approves escalations; revokes |
| **Direct user-owned agent** | Their Claude, Codex, OpenClaw, Hermes, a cron job | Submits requests under the owner's policy; never invents authority |
| **Agentic Wallet** | OKX Onchain OS, TEE-held, restored by social login | Proves identity (SIWE) and signs payments. **Never decides policy** |
| **Marketplace buyer agent** | An agent with an ERC-8004 identity on a marketplace | Requests, when a VERIFIED marketplace binding exists |
| **Seller ASP** | Who a buyer transacts with — Untch, id `6086` | Publishes services and prices |
| **Worker agent** | Who performs the work — currently also `6086` | Executes owned work. A *separate field* from the seller, because they diverge the moment Untch brokers somebody else's service |
| **Provider** | A third party that fulfils a capability | Executes and is paid, on `provider_execution` routes only |
| **Approval operator** | A human authorised to answer an escalation | Approves or rejects one exact digest |
| **Settlement facilitator** | The OKX x402 facilitator | Submits the buyer's signed authorization |
| **Broker** | Stateful commercial counterparty for A2A | **Not built.** Untch may run its own eventually |
| **Untch policy engine** | 15 deterministic rules, no model in the path | Decides. Writes evidence and reservations |

### The separation that matters

```
Agentic Wallet protects the signing key.
Untch decides whether the requested spend is permitted.
```

Neither can do the other's job, and that is deliberate: it is what keeps Untch from becoming a
custodian.

---

## The two-credential contract — LIVE

Proven in production on 2026-08-03. A payment does **not** establish who is asking.

```
Payment authorization  proves who is PAYING.
Account session        proves which UntchAccount is REQUESTING.
Policy authority       proves what that account has ALLOWED.
```

All three must agree before Untch evaluates and commits.

| Credentials presented | Result |
| --- | --- |
| Payment only | **401 `ACCOUNT_LINK_REQUIRED`** — nothing settles |
| Session only | **402 Payment Required** — nothing settles |
| Session **and** payment, agreeing | Evaluated, decided, committed |

The x402 middleware settles only on a 2xx, so a request that cannot be attributed costs the caller
nothing. That is the correct order: attribute first, charge second.

---

## Authority paths

Not every agent calling Untch owns an Untch account. There are four ways to hold authority, and they
are not equivalent.

### 1. Direct Untch account — **LIVE**

```
UntchAccount → permanently bound wallet → SIWE proof → account session
→ policy owned by that same proven wallet → direct-account requester (V3)
```

`buyerAgentId` is **absent**; `onchainBuyerAgentId` is the reserved `0` meaning *no marketplace buyer
exists*. Requires the policy to be **owned** by the account's proven wallet — a delegated policy is
refused with `REQUESTER_AUTHORITY_NOT_DERIVABLE`, because the legacy `SpendIntent` identifies a direct
requester only by the owner address and two accounts holding one delegation would be
indistinguishable on chain.

### 2. Verified marketplace agent — **implemented, not exercised in production**

```
marketplace agent identity → VERIFIED MarketplaceBinding (wallet signature)
→ marketplace requester, buyerAgentId > 0
```

A *declared* id is audit context and satisfies nothing. An unproven claim is refused with
`MARKETPLACE_BUYER_REQUIRED` rather than recorded as if it had been proven.

### 3. Explicit delegation — **NOT BUILT**

A user delegating bounded authority to an agent they do not own requires a real delegation protocol:
named agent, named capabilities, limits, expiry, and a proof of possession. Until that exists,
delegated policies are refused on the direct path rather than silently producing an unattributable
decision.

### 4. Embedded Guard middleware — **NOT BUILT**

Untch Guard sitting in the agent's signing path, so the agent *cannot* forget to ask:

```
agent creates transaction → Guard intercepts before signing → preflight
→ bounded authority returned → only then the exact transaction reaches the wallet
```

The strongest integration, because it removes the option of skipping it.

---

## A2MCP versus A2A

They are not two names for one thing.

**A2MCP — LIVE.** One callable function, structured parameters, bounded execution, a clear price and
a clear output, over one request or a short synchronous lifecycle. `preflight_payment` returns a
financial decision. `verify_delivery` returns a verification. Discovery → 402 → pay → retry → result.

**A2A — NOT BUILT.** Stateful commercial work: negotiation, scope, milestones, delivery, disputes and
settlement. It needs durable objects A2MCP does not: `ServiceOrder`, `WorkIntent`, `WorkPlan`,
`QuoteLineage`, `Milestone`, `ApprovalRequest`, `DeliveryManifest`, `Dispute`, `Settlement`,
`Receipt`. `ApprovalRequest` exists; the rest do not.

---

## Route execution profiles — LIVE

What a route may reach is a property of its **dependency type**, checked by `tsc`, not of a global
environment flag.

| Profile | Provider | Payment | Delivery |
| --- | --- | --- | --- |
| `decision_only` — `/preflight_payment` | ✗ | ✗ | ✗ |
| `verification_only` — `/verify_delivery` | ✗ | ✗ | ✗ |
| `provider_execution` — Consumer Pack | ✓ | ✓ | ✓ |
| `owned_work` — services Untch performs | ✗ | ✗ | ✓ |

`DecisionOnlyDeps` cannot *name* a provider adapter, execution store, treasury signer, settlement
sender, delivery executor, receipt anchorer, channel gateway or work executor.
`assertNoExecutionDependency` fails the build if one is added; `narrowToDecisionOnly` throws by name
at runtime. Published live at `GET /execution-manifest`, beside the global flag rather than instead of
it — because `CONSUMER_EXECUTION_ENABLED=true` and "the decision route is inert" are answers to
different questions.

---

## Authority reserved versus money spent — LIVE

An approved decision grants permission. It does not move money.

```
settledSpend            money that actually moved
activeReservedExposure  approved authority, executable, unsettled
effectiveBudgetUsage    settled + reserved   ← what budget.daily enforces
```

Enforcing on **effective** stops two agents being approved against the same capacity. Reporting
**settled** separately stops an authorisation reading as a payment. A reservation is `ACTIVE` →
`CONSUMED` at settlement, or `RELEASED` / `EXPIRED` / `SUPERSEDED`. History is permanent; an expired
hold stops counting on read, before any sweeper runs.

---

## What is proven, and what is not

**Proven in production:** SIWE account authentication · existing-account resolution without
duplicates · permanent wallet binding · user-owned policy resolution · direct-account requester V3 ·
x402 service payment, exactly one charge · deterministic 15-rule evaluation · durable replay,
duplicate, cooldown and rate state · reservation semantics · public-safe V3 evidence · no provider
execution from the decision route.

**Not yet:** production ApprovalRequest writer (escalations still write the legacy table) ·
account-scoped approval delivery · human approval with atomic budget recheck · re-quote supersession ·
provider execution bound to a reservation · delivery verification for this flow · receipt anchoring
for this flow · case-first Explorer ingestion · A2A · Broker.

**The control kernel works. The full lifecycle does not yet run end to end, and this document will say
so until it does.**
