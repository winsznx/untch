# The policy predecessor

The two services OKX rejected are not under-described. They are **unreachable**. Both require a
registered spend policy, and no public route creates one — so a caller can read the listing, send
exactly what it asks for, pay, and be refused. This document specifies the missing step.

It is written against a constraint that is not negotiable: **the user remains the owner of their own
policy.** A server-owned policy would make Untch the owner of every user's spending rules, which
inverts the product. Everything below follows from that.

---

## 1. What exists today, and why it is not enough

`POST /create_spend_policy` builds the unsigned `registerPolicy` calldata. `POST
/sync_policy_registration` records the durable row from a confirmed transaction, reading the owner
from the on-chain `PolicyRegistered` event rather than assuming it.

That pair is correct and it is not a marketplace path. It requires the caller to hold an
OKB-funded wallet on X Layer, sign a transaction and broadcast it themselves. A marketplace agent
arriving through OKX has an Agentic Wallet and no obvious reason to be holding OKB, and neither route
is listed or x402-priced.

Neither is a hosted policy the answer. `POST /create_policy_hosted` — the server signs
`registerPolicy` and hands back an id — would work on the first call and be wrong forever after:
`registerPolicy` sets `owner = msg.sender`, so the server would be the owner, and
`updatePolicy`/`pausePolicy` are gated on `msg.sender == p.owner`. The user could never change or
pause their own rules. That is not a hosted convenience; it is custody of the control plane.

---

## 2. Can the current contract support a relayed registration?

**No.** Read `contracts/src/PolicyRegistry.sol`:

```solidity
function registerPolicy(address agent, bytes32 policyHash, uint64 expiry)
    external returns (uint256 policyId)
{
    ...
    uint256 nonce = ownerNonce[msg.sender];
    policyId = previewPolicyId(msg.sender, nonce);
    ...
    _policies[policyId] = Policy({ owner: msg.sender, ... });
    emit PolicyRegistered(policyId, msg.sender, agent, policyHash, expiry, 1);
}
```

Ownership is `msg.sender`, full stop. There is no signature parameter, no forwarder, and the contract
says so in its own comments: *"signature verification (no relayer / EIP-712 here — direct
`msg.sender == owner` gating is sufficient for this first contract)"*. A relayer that pays the gas
becomes the owner. There is no way to sponsor a registration on the deployed contract without
transferring ownership of the policy to the sponsor.

One useful property does already exist. `previewPolicyId(owner, nonce)` is `pure` and `public`, and
the id is `uint256(keccak256(abi.encodePacked(owner, nonce)))` — so given an owner address and their
current `ownerNonce`, the policy id is **predictable before the transaction confirms**. That is what
lets a draft show the user the id they are about to create. It is not permission to record it as real:
a draft becomes `CONFIRMED` only from a decoded `PolicyRegistered` event, because a predicted id and a
reverted transaction look identical from the server side.

### The exact change required for sponsorship

Two options. Both are contract changes and both are out of scope for this pass.

**Option A — EIP-712 `registerPolicyFor`.** Add:

```solidity
bytes32 public constant REGISTER_TYPEHASH = keccak256(
    "RegisterPolicy(address owner,address agent,bytes32 policyHash,uint64 expiry,uint256 nonce,uint256 deadline)"
);

function registerPolicyFor(
    address owner,
    address agent,
    bytes32 policyHash,
    uint64  expiry,
    uint256 deadline,
    bytes calldata signature
) external returns (uint256 policyId);
```

It must: recover the signer over the EIP-712 struct with this contract's domain separator; require
`signer == owner`; require `block.timestamp <= deadline`; consume `ownerNonce[owner]` — the SAME
counter `registerPolicy` uses, so the two entry points cannot mint colliding ids; and write
`owner: owner`, not `msg.sender`.

Cost: one new external function, a domain separator, a typehash, and signature recovery. It does
**not** change any existing storage layout, so the existing deployment's policies are unaffected by a
redeploy — but the registry address changes, which means `POLICY_REGISTRY` moves and every stored
policy's `onchain_ref` points at the old contract. That migration is the expensive part, not the
Solidity.

**Option B — ERC-2771 trusted forwarder.** Inherit `ERC2771Context`, replace `msg.sender` with
`_msgSender()` in `registerPolicy`, `updatePolicy`, `pausePolicy` and `resumePolicy`, and set a
trusted forwarder at construction. Smaller diff, but it puts a permanently trusted address into the
contract, and a compromised forwarder can register a policy as anyone. Option A's blast radius is one
signature; Option B's is every policy.

**Recommendation: Option A**, and only after the account model and the wallet-linking flow are live —
sponsoring a registration for a wallet whose account binding does not yet exist would be sponsoring a
transaction on behalf of somebody nobody has identified.

### The zero-contract-change path

The user's own wallet sends `registerPolicy` and pays the OKB gas. This works on the deployed contract
today. It requires the OKX Agentic Wallet to hold OKB on X Layer, which is a funding problem rather
than a protocol problem, and a funding problem has a UI answer.

**This is the path pass 2 should implement first.** Sponsorship is an improvement on it, not a
prerequisite for it.

---

## 3. The design

Seven steps. Steps 1–2 and 5–7 need no chain transaction and are what this pass builds. Steps 3–4 are
the user's wallet acting, and are pass 2.

### 1. Draft

`POST /policy/draft` → `{ draftId, policyHash, previewPolicyId, rules }`

The user states their rules. The server canonicalises them, hashes them the way the registry will hash
them, and stores a `DRAFT` row against their account. Nothing is on chain and nothing evaluates
against a draft.

`previewPolicyId` is computed from `previewPolicyId(ownerAddress, ownerNonce)` read from the contract.
It is shown, labelled as predicted, and never recorded as the policy id.

### 2. Prepare

`POST /policy/draft/:draftId/registration` → `{ to, calldata, chainId, gasEstimate, previewPolicyId }`

The unsigned transaction, for the user's wallet to sign. The server never signs it. This is the
existing `create_spend_policy` mechanism, re-pointed at a draft so the rules that were reviewed are
provably the rules that get registered — the hash in the draft must equal the hash in the calldata,
and the route refuses if they differ.

### 3. Sign and broadcast *(user's wallet — pass 2)*

The OKX Agentic Wallet signs and broadcasts. Untch never holds the key. On success the client returns
the transaction hash.

### 4. Optional sponsorship *(pass 2, contract change required)*

With Option A above, the wallet signs the EIP-712 struct instead of a transaction, and a relayer
broadcasts `registerPolicyFor`. Ownership still lands on the signer. Until that function exists, this
step does not exist and must not be advertised.

### 5. Sync

`POST /policy/draft/:draftId/sync { txHash }` → `{ policyId, owner, policyHash, version }`

The server waits for the receipt, decodes `PolicyRegistered`, and reads `owner` and `policyId` **from
the event**. It refuses if:

- the transaction reverted;
- no `PolicyRegistered` was emitted;
- the emitted `policyHash` differs from the draft's;
- the emitted `owner` is not the account's proven wallet.

Only then does the draft become `CONFIRMED`, the policy get linked to the account as `registered`, and
the durable policy row get written. The last refusal is the important one: it stops a caller from
claiming somebody else's registration by pointing at their transaction hash.

### 6. List and read

- `GET /policy` → every policy on the account, with its status, version and whether it is the default.
- `GET /policy/:policyId` → `{ policyId, policyHash, version, owner, status, agentId, expiry }`.

`GET /policy/:policyId` closes a specific gap: `policyHash` had no route that returned it, which is
why it was a predecessor with `obtainableBy: null` on both rejected services. It is free and
unauthenticated — a policy id and its hash are public on-chain data, and pretending otherwise was
never the protection; the ownership check on scoped reads is.

### 7. Choose a default

`POST /policy/default { policyId }`

Sets `untch_accounts.default_policy_id`, which is what `useDefaultPolicy` in the public preflight
request resolves against. The store refuses a policy the account does not hold, in the `WHERE` clause
rather than in a prior read, so a concurrent unlink cannot slip past it.

A default is a **choice**. `last_used_policy_id` is a **fact**, recorded separately, and never promoted
— otherwise one experiment silently becomes the limit every future request is judged against.

---

## 4. What this pass built

| Piece | State |
| --- | --- |
| `untch_policy_drafts` table, with its lifecycle constraints | **done** (migration 015) |
| Draft create / read / list, submit, confirm, in `PgAccountStore` | **done** |
| `CONFIRMED` reachable only from `SUBMITTED` | **done**, tested against real Postgres |
| One draft per registered policy | **done**, partial unique index |
| Account ↔ policy link, default policy, last-used policy | **done** |
| HTTP routes for steps 1, 2, 5, 6, 7 | **pass 2** |
| Wallet signing and broadcast | **pass 2** |
| Sponsored registration | **pass 2, and needs the contract change in §2** |

No transaction is sent by anything in this pass. No contract is deployed. No policy is registered on
mainnet.

---

## 5. Why the two rejected services stay withheld until this lands

The service registry records `obtainableBy: null` on the policy predecessor, and the listing generator
refuses to emit an entry for any service carrying one. That is mechanical, not editorial: when steps
1–7 exist, `obtainableBy` becomes `"POST /policy/draft → sign → POST /policy/draft/:id/sync"`, the
predecessor stops blocking, and both services become listable in the same commit that makes them
callable.

Until then, listing them would be advertising a door that is locked.
