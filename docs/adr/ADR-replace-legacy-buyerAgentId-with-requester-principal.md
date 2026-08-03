# ADR: Replace legacy `buyerAgentId` with a RequesterPrincipal commitment

**Status:** Accepted. Off-chain half **implemented** as metadata schema V3; the on-chain half
remains scheduled.
**Date:** 2026-08-03
**Supersedes nothing. Superseded by:** the future SpendIntent version described below.

## The problem, stated precisely

`SpendIntent` is a deployed EIP-712 struct with eleven fields
(`packages/canon/src/spendIntent.ts`). Exactly one of them can identify who is asking:

```
owner            address    ← the policy's on-chain owner
buyerAgentId     uint256    ← a marketplace agent id
workerAgentId    uint256
token            address
maxAmount        uint256
taskHash         bytes32
acceptanceHash   bytes32
schemaHash       bytes32
policyHash       bytes32
deadline         uint256
nonce            uint256
```

There is no `policyId`, no `recipient`, no `accountId` and no quote digest. A user calling
Untch directly — under a policy their own wallet registered on chain, with no marketplace
anywhere in the transaction — has no honest value for `buyerAgentId`. Until 2026-08-03 the
resolver required one anyway, so the direct path was unreachable: the only two sources were a
wallet-proven marketplace binding, for which no public route exists, and a caller-supplied
claim. That is the "unobtainable predecessor" defect the service registry's `predecessors`
field was built to expose, sitting on the money path.

## What we did instead, and why it is not the fix

`buyerAgentId = 0` is now the reserved protocol-level null for a direct account request. It
means exactly `NO MARKETPLACE BUYER EXISTS FOR THIS REQUEST`, recorded explicitly as
`buyerAgentIdSemantics: no_marketplace_buyer` in V3 evidence so no reader has to infer it.

It is deliberately **not** described as ERC-8004 agent 0. ERC-8004 identifies an agent by a
registry coordinate *and* an ERC-721 token id, so a bare `uint256` cannot express a globally
unambiguous agent identity in the first place, and the standard treats payment as separate from
agent identity. Registering an ERC-8004 agent purely to populate this field would add identity
ceremony without supplying the registry namespace the field is missing.

The real requester is committed **off chain** — in the canonical quote, the quote digest, the
approval digest, the decision evidence and the metadata commitment — all of which can change
without touching a deployed contract.

## Why the zero value is safe today

Because `owner` transitively identifies the account, and only on the ownership path:

1. `mapping.ts` sets `SpendIntent.owner` to the policy's on-chain owner.
2. A direct account request requires that owner to be a wallet this account proved with SIWE.
3. `untch_wallet_bindings` has `PRIMARY KEY (chain_kind, address)` — one address belongs to at
   most one account, enforced by a unique index rather than by code.

So `owner` names exactly one account, and no second account can produce the same intent hash.

The analysis also found where this fails, which is why the direct path now refuses it: a
**delegated** policy is owned by somebody else's wallet, so `owner` names a party who is not the
requester, and two accounts holding the same delegation would produce byte-identical intent
hashes for an identical request. Before the zero value, `buyerAgentId` carried the
distinguishing entropy; with it reserved, that entropy is gone. Delegation therefore continues
to work through the marketplace path, where a buyer agent id identifies the requester, and is
refused on the direct path with `REQUESTER_AUTHORITY_NOT_DERIVABLE`.

## The policy-identity limitation, stated as a published contract term

`(owner, policyHash)` does not pin a `policyId`. Production currently holds four groups of
policies sharing an owner and a ruleset hash, one of them with five members. Two policies with
the same owner and identical rules confer identical authority, so this does not affect **who may
spend** or **under what rules** — but the deployed contract cannot say *which* of them was
evaluated.

Precisely:

- The legacy on-chain `SpendIntent` commits `policyHash` — the **ruleset bytes**.
- V3 metadata commits `policyId` — the **exact policy selected** — in the quote digest, the
  approval digest, the decision evidence, the metadata commitment, the receipt metadata and the
  activity case.
- The existing contract **cannot independently distinguish two policies that share the same owner
  and the same `policyHash`**. Only the off-chain evidence can.

Every V3 record carries this as a stored field rather than as documentation:

```
policySelectionSemantics: exact_offchain_policy_id_legacy_onchain_policy_hash
```

It is a column on `untch_decision_evidence`, a member of the V3 metadata commitment, and a member
of the V3 quote digest — so a reader holding only the record is told the on-chain side is the
weaker one, and cannot infer a policy identity the chain does not actually provide.

What this does **not** mean: it is not a spend-authority gap. An attacker who substituted policy
B for policy A would be substituting a policy with the same owner and byte-identical rules, which
authorises exactly the same spending. What is lost is *attribution between indistinguishable
twins*, and V3 recovers it off chain rather than claiming the chain does it.

The upgrade below removes the limitation by committing the requester and the policy identity in
the struct itself.

## The upgrade

A future `SpendIntent` version should commit the requester directly, removing the dependence on
`owner` for identity and the need for a reserved null:

- requester principal **kind** — `untch_account` | `marketplace_agent`
- requester principal **namespace** — which registry or authority the reference is scoped to,
  the field whose absence makes today's bare `uint256` insufficient
- requester principal **reference** — the account ref hash, or the agent coordinate
- optional **marketplace identity** — present only for a marketplace request
- **seller identity** — the ASP being transacted with
- **worker identity** — who performs the work, which is not always the seller

This is a new struct hash, a new EIP-712 domain, and a redeployment of the intent and receipt
registries. It invalidates nothing retroactively: V1 and V2 evidence keep verifying under their
own rules, and V3 evidence keeps verifying under the reserved-null interpretation.

## What was implemented, and where

Metadata schema **V3**, entirely off chain:

| Concern | Where it lives |
| --- | --- |
| Requester principal, wallet authority, commitments | `packages/consumer-core/src/requester-principal.ts` |
| V3 evidence, quote digest, metadata commitment, receipt verifier | `packages/consumer-core/src/decision-evidence.ts` |
| Requester binding in the approval digest (`v=2`) | `packages/consumer-core/src/approvals.ts` |
| Public/private projections and the never-render list | `packages/consumer-core/src/requester-presentation.ts` |
| Columns and CHECK constraints | `packages/consumer-core/migrations/025_decision_evidence_v3_requester.sql` |
| Resolution of who is asking | `services/asp/src/public-dto/authority.ts` |

`walletAuthorityRef` is the piece worth naming here. It hashes the wallet authority **state**,
including `verifiedAt`, so a binding that is revoked and later reactivated on the same account —
the only way back, since migration 024 never frees the address — produces a *different* authority.
An approval created before the revocation therefore matches nothing after it, and reactivation
cannot revive it, while decisions already taken keep their original reference and still read
correctly.

One behaviour became **stricter** than the ADR originally implied: an unverified, caller-supplied
`buyerAgentId` is now refused (`MARKETPLACE_BUYER_REQUIRED`) rather than recorded as a labelled
claim. Under V2 the `verified: false` label was sufficient, because nothing downstream read it as
authority. Under V3, `buyerAgentIdSemantics` is a committed field that a stranger reads off a
receipt with no way to see a label that lived in a response body months earlier. A caller with no
marketplace identity is not blocked: omitting the field *is* the direct account path.

## What this ADR explicitly does not authorise

- Redeploying `PolicyRegistry`, `SpendIntentRegistry` or `UntchReceipts` in this pass.
- Invalidating the current user-owned policy
  `6005881688159874338903650523776790675151043356117181716643196935468657631674`.
- Treating the reserved zero as a permanent answer. It is a compatibility shim with a scheduled
  replacement, and the scheduling is the reason it is acceptable.

## Consequences

- A direct account request works today, on mainnet, with no contract change.
- Any reader of the raw contract sees `agentId = 0x00…00`. Public surfaces must render
  `Marketplace buyer: none`, never `Agent ID 0`, `Buyer #0` or `Unknown agent`; raw contract
  views may show `legacyAgentId` alongside
  `legacyAgentIdSemantics: NO_MARKETPLACE_BUYER_V3`.
- A V1 or V2 receipt must never inherit the V3 null interpretation. Under V1 and V2 a zero
  `buyerAgentId` remains what it always was: a decision receipted against an agent that does not
  exist, and therefore invalid.
