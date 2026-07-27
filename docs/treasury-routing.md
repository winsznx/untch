# Treasury routing

Pre-funded operational floats, capability-scoped spending, and no bridge anywhere near a request.

## The shape

```
USER FUNDING            X Layer (196) USDT0   ← one front door, matches OKX distribution
PROVIDER SETTLEMENT     Base (8453) USDC      ← StableDomains, StableEmail, StableMerch, StableTravel
                        Solana USDC           ← Purch (not executable: payload shape unconfirmed)
                        Tempo (4217) MPP      ← not executable: currency encoding unconfirmed
```

Each settlement rail carries a float that an operator funds out of band. There is **no swap and no
bridge on the request path**.

## Why no request-path rebalancing

A `Rebalancer` interface exists so the seam is real. `NoopRebalancer` is the only implementation, and
`assertRebalancingDisabled()` runs at `TreasuryRouter` construction and **throws** if anything is
enabled:

> automatic treasury rebalancing is enabled, but this build has no tested production bridge. A
> request-path swap or bridge would move user funds through an unproven code path at the worst
> possible moment.

That makes "no request-path bridge" a property the code enforces rather than a sentence a future
change can quietly falsify. It is asserted in the suite.

Replenishment is a documented human step: [runbook → low balance](./consumer-pack-runbook.md#low-provider-wallet-balance).

## Capability-scoped payment

An adapter never sees a private key. It receives a `PaymentCapability` whose only method is `pay()`,
pre-bound to:

- one **intent**
- one **chain** and one **asset**
- one **ceiling** (`maxAmount`)
- one **recipient allowlist**
- one **expiry** (5 minutes by default — an authority that outlives its execution is a liability)

Private keys live inside `RailClient` implementations that only the router constructs. A compromised
adapter's entire blast radius is one intent's authorised amount to an already-allowlisted recipient.

### Everything is checked twice, in two different places

At **mint** time, `TreasuryRouter.issueCapability` checks pause flags, rail availability, the
settlement treasury account, a non-empty recipient allowlist, the per-provider per-transaction cap,
the daily cap, and the float's minimum balance. By the time an adapter holds a capability, the only
remaining failure is the merchant's own.

At **spend** time, the capability itself re-checks asset, ceiling, positivity and recipient — because
an adapter holding the object cannot reach the rail client except through `pay()`.

### Single use, redeemed before signing

`consumeCapability` runs `SELECT … FOR UPDATE` then `UPDATE … WHERE consumed_at IS NULL`. Two workers
racing the same intent produce one payment and one refusal.

Redemption happens **before** the rail signs. If the process dies between redeeming and settling, the
capability is already spent and the intent lands in reconciliation — which is the correct outcome.
Redeeming after signing would leave a window where a crash permits a re-sign. This is asserted in the
suite with a rail that throws.

### Two tiers

- **Discovery capability** — cents-scale ceiling, minted per read call. These providers charge for
  reads (StableDomains: $0.01 to search, $0.05 to check; Purch: $0.01 to search), and paying for them
  out of the execution authority would let a search consume authority a human granted for a purchase.
- **Execution capability** — bound to the approved quote's exact provider cost.

## Limits and floors

| Control | Where | Effect |
|---|---|---|
| `perTxMax` per provider/asset | `consumer_provider_limits` | refuses at mint |
| `dailyMax` per provider/asset | same | refuses at mint |
| `dailyLimit` per treasury account | `consumer_treasury_accounts` | refuses at mint |
| `minBalance` floor | same | refuses if the payment would drop the float below it |
| `CONSUMER_MAX_SINGLE_EXECUTION` | env | refuses at quote time |

The floor is not a safety margin for its own sake — it stops a single large purchase from draining a
rail and stranding every cheap action queued behind it.

## Kill switches

One table, five scopes, checked in order of blast radius so the most severe reason is reported:

`GLOBAL` → `CHAIN` → `ASSET` → `PROVIDER` → `TREASURY_ACCOUNT`

Any engaged pause refuses a capability **before it is minted**, so nothing reaches a rail. Engaging
one is a single `INSERT` — see the [runbook](./consumer-pack-runbook.md#emergency-pause-and-recovery).

## The double-entry ledger

Append-only. `UPDATE` and `DELETE` on `consumer_ledger_entries` are rejected by Postgres RULEs, so a
correction must be a reversing entry that stays visible.

**An entry group is single-asset and sums to exactly zero.** That constraint is what keeps "balanced"
checkable in SQL. Summing USDT0 on X Layer and USDC on Base into one figure would require a price,
and a ledger whose correctness depends on a price feed can be made to balance by moving the price. A
cross-rail movement is therefore **two groups**, never one.

| Group | Entries | Asset |
|---|---|---|
| `FUNDING` | `+total` TREASURY, `−total` USER_OBLIGATION | funding |
| `SETTLEMENT` | `+cost` PROVIDER_SETTLEMENT, `−cost` TREASURY | settlement |
| `RECOGNITION` | `+total` USER_OBLIGATION, `−fee` FEE_REVENUE, `−spread` SPREAD_REVENUE, `−remainder` COST_OF_GOODS | funding |
| `REFUND` | `+amount` USER_OBLIGATION, `−amount` REFUND_PAYABLE | funding |
| `SUSPENSE_MOVE` | `+amount` USER_OBLIGATION, `−amount` SUSPENSE | funding |

`remainder` in `RECOGNITION` is **computed**, never supplied, so the group cannot be made to balance
by passing a cost-of-goods figure that does not follow from the quote. A zero fee and a zero spread
stay as explicit zero rows — an absent row and a zero row read very differently in an audit.

Each kind happens **at most once per intent** (`UNIQUE (intent_id, kind)` for non-`ADJUSTMENT`
groups), which makes "no intent is executed twice" checkable against money rather than against status.

### The settled invariant

`assertIntentSettled` asserts a completed intent's `USER_OBLIGATION` is exactly zero — everything the
user funded has been recognised as fee, spread or cost of goods, with nothing unaccounted for. It
holds for refunded and suspended intents too: the money moved somewhere named.

**Balances are always `SUM(entries)`.** No mutable balance column is authoritative anywhere.

## Reconciliation

`TreasuryRouter.reconcile()` compares each float's on-chain balance against the ledger position and
records the drift in `consumer_treasury_balances`.

Drift is **recorded and never auto-corrected**. An automatic correction would make the ledger agree
with the chain by construction and destroy its value as an independent record.

## Fees and spread

| Action | Fee (bp) |
|---|---|
| `shop.purchase` | 200 |
| `domains.register` / `domains.renew` | 150 |
| `travel.book` | 200 |
| `gifts.order` | 200 |

Plus a disclosed cross-rail spread of 50 bp, which absorbs price movement between the funding leg and
the settlement leg.

Both round **CEIL**; payouts round **FLOOR**. Rounding can therefore never synthesise a unit that did
not exist — asserted in the suite. `applyBasisPoints` requires an explicit rounding mode: a fee that
silently rounds the wrong way is a ledger that silently fails to balance.

## The custodial boundary, stated plainly

Between `FUNDED` and `COMPLETED`, **Untch holds the value as an operator**. This is a custodial
ledger. It is not trustless and is not described as such anywhere.

Making it non-custodial needs a `ConsumerEscrow` contract with expiry, replay protection, reentrancy
protection, token allowlists, exact-amount binding, refund paths, verifier binding and emergency
pause. `UntchVault` cannot stand in: it has no per-intent lock and no refund path, and its only exit
is `ownerWithdraw`, which is the §16 I4 sovereign escape hatch — unconditional, never paused, never
oracle-gated. Using it as a refund primitive would bypass every control the vault has.

That contract needs its own design and threat model before a line of Solidity is written. It is the
top item in the remaining-risks list.
