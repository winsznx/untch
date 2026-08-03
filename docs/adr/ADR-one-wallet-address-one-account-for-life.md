# ADR: One wallet address belongs to one UntchAccount for its lifetime

**Status:** Accepted and enforced (migration 024).
**Date:** 2026-08-03
**Related:** [ADR: Replace legacy `buyerAgentId` with a RequesterPrincipal commitment](./ADR-replace-legacy-buyerAgentId-with-requester-principal.md)

## Why this is load-bearing rather than tidy

The deployed EIP-712 `SpendIntent` has eleven fields and none of them names an account:

```
owner  buyerAgentId  workerAgentId  token  maxAmount  taskHash
acceptanceHash  schemaHash  policyHash  deadline  nonce
```

For a **direct Untch-account request** `buyerAgentId` is the reserved zero, so the only field that can
identify a requester is `owner` — set by `mapping.ts` to the policy's on-chain owner address. That
address identifies an *account* only because an address belongs to exactly one account.

So the chain of attribution is:

```
SpendIntent.owner  →  policy owner address
                   →  the wallet binding that proved it   (SIWE, ACTIVE, this account)
                   →  exactly one UntchAccount            (PRIMARY KEY (chain_kind, address))
```

Break the last link and the first one stops meaning anything. A receipt anchored under
`owner = 0xA…` would name whichever account held `0xA…` at the time, and one intent hash would
describe two different payers at two different moments, with nothing on chain showing the difference.

This invariant is therefore a **precondition of the `buyerAgentId = 0` compatibility design**, and it
stops being load-bearing only when the future `SpendIntent` version commits a requester principal
directly.

## The conflict this resolves

Two things in the repository disagreed:

- **Production schema (migration 015):** `PRIMARY KEY (chain_kind, address)`, with the comment
  "One address belongs to at most one account."
- **PASS 2 language:** a test titled *"a revoked wallet keeps its row, stops resolving, and **frees the
  address for a replacement**"*, and a comment in `accounts.ts` promising that
  "re-binding after revocation goes through `rebindWallet`".

Neither PASS 2 claim was real:

- The test's **body** binds a *different* address (`EVM_B`) to the *same* account. It never freed
  `EVM_A` and never asserted that it did. Only the title said otherwise.
- **`rebindWallet` does not exist.** It was never written. The documented path back from a revocation
  was a name with nothing behind it.

The schema was right and the prose was wrong. The prose is now corrected, and the missing behaviour
(reactivation) is implemented rather than referred to.

## The invariant, as enforced

| Behaviour | Mechanism |
|---|---|
| First valid proof creates or resolves one account | `linkWallet` upsert |
| Re-linking the same address resolves the **same** account | `WHERE account_id = EXCLUDED.account_id` |
| Revocation disables authority | `status = 'REVOKED'`, `accountForWallet` returns null |
| Revocation does **not** free the address | the row stays; the PK is on the address |
| Reactivation restores authority to the same account | upsert now clears `revoked_at` and sets `ACTIVE` |
| `account_id` cannot be UPDATEd | trigger `untch_wallet_binding_permanence` |
| The address cannot be rewritten | same trigger |
| A binding cannot be DELETEd | same trigger — deletion *would* free the address |
| A recorded proof cannot be unset | same trigger |
| Another account cannot claim it | `WALLET_PERMANENTLY_BOUND_TO_DIFFERENT_ACCOUNT` |

The triggers exist because the uniqueness that protects the invariant is the *presence of the row*.
A `DELETE` from a repair script or a console session would have released the address without touching
any application code, and no test would have noticed.

## Why the refusal is thrown rather than returned

`linkWallet` previously declined a cross-account move silently: the upsert matched no row and the
caller got `bound: false` — the same answer a harmless duplicate link produces. Those are different
facts. One means "nothing needed doing"; the other means "you asked to move an identity between
accounts", which the system does not do at all. A caller that cannot tell them apart will eventually
report the wrong one to a person.

## What this deliberately does not solve

Account recovery and account merging are real needs. A user who loses a wallet, or who wants two
accounts to become one, has a legitimate request and this ADR gives them no path.

That is intentional. The answer is an explicit, audited protocol with a human in it — not an
`UPDATE`, and not an idempotent write that happens to have a surprising effect. When that protocol is
built it will have to lift these triggers deliberately, in its own migration, with its own review.
That friction is proportionate to what the operation actually does: reassign every past decision
attributable to an address.

Until then, `WALLET_PERMANENTLY_BOUND_TO_DIFFERENT_ACCOUNT` is the honest answer, and it says so.

## Consequences

- The direct-account substitution proof holds, and its last link is now enforced by the database
  rather than by convention.
- Losing sole control of a wallet currently means losing that account's authority, with no migration
  path. This is a known, accepted gap with a named refusal rather than a silent failure.
- When the future `SpendIntent` commits a requester principal, this invariant becomes a useful
  property rather than a security dependency, and a recovery protocol becomes correspondingly less
  dangerous to build.
