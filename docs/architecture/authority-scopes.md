# Identity is not authority

A wallet that proves who you are does not thereby carry permission to spend.

This was established live rather than on paper. The first attempt at the escalation-gate production
proof linked a wallet requesting only the `identity` scope, and the paid account route answered:

```
HTTP 409 AUTHORITY_NOT_DERIVABLE
this wallet is bound for identity only: it proves who you are and does not carry
authority to spend under a policy
missing: scopes — binding wbnd_3e3a673e… has [identity] and needs policy-authority
```

Nothing settled and nothing was written. The request had a valid session, a real wallet, a genuine
SIWE proof, and it still could not reach the policy engine.

## The two scopes

| | `identity` | `policy-authority` |
|---|---|---|
| Proves | which account and wallet are present | that this session may invoke policies controlling money or reserved authority |
| Enough for | reading your own account, listing policies, proving a name | evaluating a spend, reserving budget, raising a paid escalation |
| Granted by | any successful SIWE link | a link that explicitly requested it |

A valid identity session does not inherit financial authority. It has to be asked for, and asking for
it is a separate thing a wallet holder does deliberately.

## Why they are separate at all

An identity proof answers "who is here". A spend answers "who may move this money". Collapsing them
means every place that learns who you are also gains the right to act as you, and the blast radius of
a leaked or over-scoped session becomes the account's whole balance rather than its name.

The split also makes revocation meaningful. `walletAuthorityRef` hashes the wallet's authority state
including the moment it was proven, so revoking a binding and later reactivating it produces a
different value. Work authorised under the old authority matches nothing afterwards, and reactivation
cannot revive it.

## Every refusal on the direct account path

Each of these is checked independently. Passing one says nothing about the others.

| Condition | Outcome |
|---|---|
| no session at all | `ACCOUNT_LINK_REQUIRED` |
| session valid, binding has only `identity` | `AUTHORITY_NOT_DERIVABLE` |
| binding not ACTIVE | refused, re-read at request time rather than trusted from the token |
| wallet authority revoked | refused before the session token expires on its own |
| account SUSPENDED | refused |
| policy paused | refused, no transaction needed |
| policy expired | refused |
| policy owned by a wallet this account never proved | refused before delegation is even considered |
| policy merely delegated, not owned | refused on a direct request |
| marketplace binding declared but unproven | treated as a direct account, never as marketplace intent |
| caller-supplied agent id with no signature | refused, not recorded as a claim |

Identity is re-read on every request rather than taken from the token. A session is a claim about a
moment, and the binding behind it can change inside that session's lifetime. A revoked wallet stops
being able to spend well before its token expires, because the check reads the binding rather than
the bearer.

## What must not happen to make integration easier

The approval path will eventually let a human act on a request, and that human will arrive through a
channel with its own identity. The temptation there is to accept a weaker proof because the
approval-time flow is inconvenient. Do not weaken the scope check to make that work.

An approval action is not the same permission as a spend, and neither one is implied by proving a
name. When channel binding is built, it gets its own authority story rather than borrowing this one.
