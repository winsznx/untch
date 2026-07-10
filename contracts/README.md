# Untch contracts

Solidity contracts for Untch, built with [Foundry](https://book.getfoundry.sh/) and gated by the
PRD §28 audit & test pipeline. The toolchain was stood up in **D0.4** on a throwaway scaffold; the
canonicalization differential landed in **D0.5**. This directory now holds the **complete set of five
real product contracts** — [`PolicyRegistry`](src/PolicyRegistry.sol) (§10.1),
[`SpendIntentRegistry`](src/SpendIntentRegistry.sol) (§10.2),
[`UntchReceipts`](src/UntchReceipts.sol) (§10.3),
[`UntchVault`](src/UntchVault.sol) (§10.4 — the first fund-holding contract), and
[`UntchVaultFactory`](src/UntchVaultFactory.sol) (§10.4 — the CREATE2 factory that deploys vaults at
per-`(owner, agent)` deterministic addresses) — plus the shared
[`AuthorizedWriters`](src/AuthorizedWriters.sol) access-control base, each taken through the full §28
pipeline for real and deployed + verified on X Layer testnet.

*Public proof. Private work. Accountable payment.*

## What's real here

| Path | What it is | Status |
|------|-----------|--------|
| [`src/PolicyRegistry.sol`](src/PolicyRegistry.sol) | PRD §10.1 — on-chain anchor: a committed ruleset (`policyHash`) governed a given agent at a given time. Owner-gated register / update / pause / resume, event per mutation. | **Real & LIVE on X Layer testnet** at [`0xe1d7…3532`](https://www.oklink.com/x-layer-testnet/address/0xe1d74c90801db0fa806c72eb818b7671b8233532) (verified source; one demo policy registered + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/SpendIntentRegistry.sol`](src/SpendIntentRegistry.sol) | PRD §10.2 — on-chain lifecycle anchor: `intentHash ⇒ {policyId, maxAmount, deadline, status}`. `intentHash` derived on-chain from the §8.1 struct via `IntentHash`; **authorized-writer-set** register / setStatus; status ∈ {PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED} with derived expiry. | **Real & LIVE on X Layer testnet** at [`0xf87e…1372`](https://www.oklink.com/x-layer-testnet/address/0xf87e50f83172c2dace7d274e4c701212caeb1372) (verified source; one demo intent registered + transitioned + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/UntchReceipts.sol`](src/UntchReceipts.sol) | PRD §10.3 — the versioned, **events-only** public receipt log: `logReceipts` (batch), `anchorScore`, `anchorAudit`, all writer-gated; admin writer-set changes behind a **timelock**. On-chain carries hashes/metadata only. | **Real & LIVE on X Layer testnet** at [`0x0c64…4863`](https://www.oklink.com/x-layer-testnet/address/0x0c64997277b7d94d2999dea22a123cac56334863) (verified source; a real 3-receipt batch logged, one score + one audit anchored, writer authorized through the real timelock, independently read back via raw RPC). Full §28 pipeline green. **Measured gas/receipt published** (see below). |
| [`src/UntchVault.sol`](src/UntchVault.sol) | PRD §10.4 / §7.5 — the **first fund-holding contract**: Mode C on-chain spend enforcement. `deposit`, EIP-712 oracle-signed `spend` (with a cross-contract APPROVED-intent check against the real §10.2 registry when required), owner `spendFallback`, **unconditional** `ownerWithdraw`, `setOracle`, `pause`/`unpause`, `setFallbackAllowlist`, two-step `transferOwnership`/`acceptOwnership`. Its constructor is arg'd and immutable-setting; instances are deployed by `UntchVaultFactory` (below). | **Real & LIVE on X Layer testnet** at [`0x42e6…4848`](https://www.oklink.com/x-layer-testnet/address/0x42e699ffd8215d48397a049b4f7a176db06f4848) (verified source; real deposit + oracle spend anchored to the real APPROVED §10.2 intent + fallback spend + reverted over-cap attempt + ownerWithdraw, all independently re-read via raw RPC). Full §28 pipeline green; **100% branch coverage**; measured gas per spend published. See [`deploy/README.md`](deploy/README.md). |
| [`src/UntchVaultFactory.sol`](src/UntchVaultFactory.sol) | PRD §10.4 — the **CREATE2 factory** for `UntchVault`. `deployVault(owner, agent, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow[], requireAnchoredIntent)` (spec signature **verbatim**) at an address deterministic per `(owner, agent)`; `computeVaultAddress(...)` predicts it before deployment. Holds ONE canonical immutable `intentRegistry` injected into every vault (decision B). **Holds no funds, moves no money** — it only deploys vaults. | **Real & LIVE on X Layer testnet** at [`0x1562…b7e9`](https://www.oklink.com/x-layer-testnet/address/0x1562c6eb1813016c8562cf6771cbf715007bb7e9) (verified source; a real **predict → deploy → prediction-match** (`0x84BA…8975`, 0→4940 bytes) → independent raw-RPC readback of the deployed vault's immutables → `VaultAlreadyDeployed` + `OwnerMustBeSender` guards proven on-chain). Full §28 pipeline green; **100% branch coverage**. See [`deploy/README.md`](deploy/README.md). |
| [`src/AuthorizedWriters.sol`](src/AuthorizedWriters.sol) | Shared admin-managed authorized-writer allowlist (admin/writer roles, add/remove/transfer, events, errors, modifiers) — **extracted** from SpendIntentRegistry. Internal-only mutators so each derived contract chooses its surface (immediate vs timelocked). | Real base. Used by `SpendIntentRegistry` (immediate admin) and `UntchReceipts` (timelocked admin). |
| [`src/lib/IntentHash.sol`](src/lib/IntentHash.sol) | PRD §8.1 SpendIntent struct hash; the Solidity half of the D0.5 canonicalization differential. Reused by `SpendIntentRegistry` to derive `intentHash` on-chain. | Real library. |
| `src/Scaffold.sol` | The D0.4 throwaway ownable/pausable stub. | **Removed** — a real contract (`PolicyRegistry`) now exercises the same CI, so the scaffold's only remaining effect was analyzer noise. (Same call Step-1b made about `ping_untch`.) |

> **Fund custody (I4).** `PolicyRegistry`, `SpendIntentRegistry`, and `UntchReceipts` hold no funds —
> no `payable`, no `receive`, no `fallback`, no deposit/withdraw; they are pure registries/logs.
> `UntchVault` is the **one contract that deliberately does hold funds** (ERC20 balances only — still no
> `payable`/`receive`/`fallback`; it never touches native value). Its entire design is §16 I4: the
> oracle key can only authorize spends already bounded by cap / epoch budget / token allowlist /
> single-use nonce / expiry / (APPROVED anchored intent when required), and the **owner can `pause` and
> `ownerWithdraw` unconditionally** with nothing from Untch.

> **Mainnet is deliberately deferred.** Nothing here touches X Layer **mainnet** until `UntchVault`
> also exists and the full contract set clears §28's mainnet checklist together (PRD §22.4).
> Everything below is **testnet-only**.

## Two interpreted judgment calls in PolicyRegistry (correctable)

§10.1 is terse; two readings are interpretation, not verbatim spec, and are called out here and in
the contract's NatSpec so they are easy to correct if either is wrong:

1. **`policyId` derivation from the "owner nonce".** `policyId =
   uint256(keccak256(abi.encodePacked(owner, nonce)))`, where `nonce = ownerNonce[owner]` at call
   time and increments per `registerPolicy`. Chosen over a global auto-increment so any owner can
   register without contending on a shared counter, and so ids are collision-resistant across
   owners. §10.1 needs no signature verification here (no relayer / EIP-712 — direct `msg.sender
   == owner` gating suffices for this first contract), so the nonce's only role is deterministic
   id derivation.
2. **Status = `{NONE, ACTIVE, PAUSED}` with expiry DERIVED, never stored.** There is no `EXPIRED`
   state that someone would have to transition at the exact expiry second. Usability is computed:
   `isUsable = status == ACTIVE && block.timestamp <= expiry`. `NONE` is only the zero-value
   existence sentinel (so mutators reject unregistered ids), not a lifecycle state.

A third, smaller modelling choice: the governed **`agent` is typed `address`**, following §10.4's
`deployVault(owner, agent, oracle, …)` (the only place the PRD pairs `agent` with `owner`, there
as an address triple). §10.3's `bytes32 agentId` is a separate event-layer id; also correctable.

There is **no ownership-transfer function** — a policy's owner is fixed at registration
(enforced by the `invariant_OwnerNeverChanges` stateful test).

## Three decisions in SpendIntentRegistry (correctable)

§10.2 is terse; three readings are decisions, not verbatim spec, called out here and in the
contract's NatSpec so they are easy to correct if a reading was wrong. The first two are the
consequential ones — resolved deliberately, not silently.

1. **Access control = an admin-managed AUTHORIZED WRITER SET — deliberately NOT owner-gated like
   PolicyRegistry.** PolicyRegistry is owner-gated because a human registers a policy rarely,
   directly, from their own wallet. Intents are the opposite: created *constantly and automatically*
   by backend/relayer software acting on an owner's behalf, so requiring the owner's own signature on
   every intent registration would defeat the purpose of an automated policy engine. So
   `registerIntent` / `setStatus` are gated by an allowlist of writer addresses that an `admin`
   manages (`addWriter` / `removeWriter` / `transferAdmin`), mirroring the §10.3 UntchReceipts
   writer-set pattern. **This is a considered divergence from PolicyRegistry's pattern, not an
   inconsistency.** The writer key can only write into this registry's state — it holds no funds and
   authorizes no transfer (§16: "writer signs only into event log"). `admin` and `writer` are
   separate roles (least privilege): the admin manages the set but is not a writer by default.
2. **No cross-contract validation of `policyId` against PolicyRegistry in this first pass — a
   deliberate scope choice, not an oversight.** An intent maps to a `policyId`, but the contract does
   **not** call PolicyRegistry to check that the policy exists / is active / isn't expired at
   registration. By the time an intent reaches on-chain registration, the off-chain policy engine has
   already evaluated it against the real policy; on-chain re-verification here would be
   defense-in-depth, not load-bearing — and adding a cross-contract dependency in a new contract's
   first pass is exactly the kind of thing worth doing deliberately later, not folded in silently now.
   `policyId` is stored as an opaque reference; the only local guard is `policyId != 0`. **Named
   future hardening** (below).
3. **Status = `{NONE, PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED}` with expiry DERIVED, never
   stored — carrying PolicyRegistry's precedent forward.** §10.2 lists an `EXPIRED` value; it is
   deliberately **not** a stored state (nobody would reliably fire a transition tx at the exact
   second a deadline passes). Expiry is computed at read time: `isExpired = block.timestamp >
   deadline`; `isUsable = status == APPROVED && block.timestamp <= deadline` (the vault's §7.5 check).
   `NONE` is only the zero-value existence sentinel (so reads/mutators reject unregistered hashes),
   exactly as in PolicyRegistry — the five members after it are the real lifecycle states, §10.2's
   list minus `EXPIRED`. A smaller modelling choice under this same head: `setStatus` accepts **any**
   real lifecycle state from a writer and does **not** enforce a transition DAG on-chain in this first
   pass — the off-chain engine drives (and has already validated) each transition, so an on-chain DAG
   would again be defense-in-depth. **Named future hardening** (below).

The **`intentHash` is always derived on-chain** from the struct via
[`IntentHash.hashIntent`](src/lib/IntentHash.sol) (the D0.5 differential proves that library equals
the off-chain canon package). **No function accepts a caller-supplied hash** as an independent
argument, so a caller can never register a record under a hash that doesn't describe the struct it
claims — a hash/struct mismatch is unreachable by construction (asserted in
`test_RegisterIntent_HashIsDerivedFromStruct_NotSuppliable` and the sensitivity fuzz). The core
record data (`policyId`, `maxAmount`, `deadline`) is immutable after registration — only `status`
moves (enforced by `invariant_CoreDataImmutableStatusValid`).

### Named future hardening (deferred, not forgotten)

- **Cross-contract policy validation** (decision #2): have `registerIntent` call `PolicyRegistry`
  and require the referenced `policyId` to exist / be active / be usable at registration. Defense in
  depth once the two contracts are co-deployed on mainnet.
- **On-chain status-transition DAG** (decision #3): enforce a valid lifecycle graph in `setStatus`
  (e.g. `BLOCKED` terminal, `APPROVED → SETTLED/DISPUTED`) instead of accepting any state from a
  writer.
- **Admin behind a timelock** — RESOLVED as a deliberate per-contract difference, not a pending
  hardening for §10.2. §10.3 (`UntchReceipts`) requires a timelocked admin and now has one; §10.2's
  spec does not, so SpendIntentRegistry keeps its immediate admin (its deployed, testnet-verified
  behavior). Both share the same `AuthorizedWriters` allowlist; only the *surface* differs. See the
  UntchReceipts section below (judgment call 3) for why this is correct rather than inconsistent.

## The shared `AuthorizedWriters` base (a refactor, re-verified)

Both `SpendIntentRegistry` (§10.2) and `UntchReceipts` (§10.3) need the identical admin-managed
authorized-writer allowlist. Rather than write it a third time when `UntchVault` lands, it was
**extracted** into [`src/AuthorizedWriters.sol`](src/AuthorizedWriters.sol): the `admin`/`isWriter`
state, the `WriterAdded`/`WriterRemoved`/`AdminTransferred` events, the access-control errors, the
`onlyWriter`/`onlyAdmin` modifiers, and INTERNAL `_addWriter` / `_removeWriter` / `_transferAdmin`
mutators (each carrying its full guard + event).

The base is **internal-only** by design — it exposes no external `addWriter`/etc. So each derived
contract chooses how to surface writer-set changes:
- **SpendIntentRegistry** wraps them in plain `onlyAdmin` externals — **immediate** (its deployed
  behavior).
- **UntchReceipts** routes them through its timelock (`propose` → delay → `execute`).

If the base exposed an immediate external mutator, UntchReceipts would inherit an un-timelocked bypass
of its own timelock. Keeping the external surface in the derived contracts is what makes the two
access-control postures a *deliberate per-contract choice*, not an accident of inheritance.

**Re-verified, not just refactored.** SpendIntentRegistry's entire existing test suite — **all 86
tests** — passes unchanged against the refactored source, proving behavior did not drift. The only
test edit the extraction forced: 5 `vm.expectRevert` references to the now-inherited access-control
errors were requalified from `SpendIntentRegistry.X` to `AuthorizedWriters.X` (Solidity 0.8.34 does
not resolve an inherited error through the derived contract's name). The error **selectors are
byte-identical** regardless of the declaring contract, so every assertion tests the exact same
revert — the requalification is mechanical, not a weakening. Branch coverage moved with the code:
SpendIntentRegistry is now 7/7 and AuthorizedWriters 6/6, both 100%.

> The already-deployed testnet `SpendIntentRegistry` (`0xf87e…1372`) predates this extraction; its
> verified OKLink source is the pre-refactor single-file version. It is **not** being rebuilt or
> redeployed — behavior is identical (proven by the unchanged 86 tests), and mainnet is deferred.

## Three decisions in UntchReceipts (correctable), plus the timelock choice

§10.3 gives the event shapes precisely but leaves three modelling questions open. All three are
resolved deliberately and called out here and in the contract's NatSpec.

1. **`agentId` is a numeric identity id, NOT an address.** The `bytes32 agentId` in
   `ReceiptLogged`/`AuditAnchored` is the §8.1 SpendIntent's `buyerAgentId`/`workerAgentId` (a
   `uint256`) cast directly to `bytes32` — `bytes32(uint256_value)`, right-aligned. It is a
   **different concept** from the `agent: address` (real EVM wallet) that SpendIntentRegistry /
   UntchVault use: an identity-registry-style number here vs. a wallet address there. Two legitimately
   different things that share the word "agent". An indexer must **not** `address(uint160(agentId))`
   this value — that would silently truncate the id into a bogus address. (Proven on-chain: the demo
   receipt's `agentId` topic is `0x00…01` = `bytes32(uint256(1))`.)
2. **`receiptId` is caller-supplied, recorded verbatim — not derived on-chain.** SpendIntentRegistry
   derives `intentHash` on-chain because a hash/struct mismatch there would be a real correctness bug
   in a contract that **gates** money-adjacent state transitions. UntchReceipts is an append-only
   historical **log** — it gates nothing — so on-chain derivation would add complexity with no
   corresponding correctness benefit. The writer supplies `receiptId`; the contract records it. This
   is a considered scope choice, not an oversight. (The only content guards are on the two anchors,
   which reject a zero primary hash — meaningless anchors — matching the repo's reject-meaningless
   discipline; receipts themselves are recorded unvalidated.)
3. **The admin timelock — custom two-step, chosen over OpenZeppelin's `TimelockController`.** §10.3
   requires the admin behind a timelock. Two options were weighed against the actual OZ source:
   - **(a) import `TimelockController`** — ~565 lines that inherit `AccessControl` **+ `ERC721Holder`
     + `ERC1155Holder`** (the latter two add NFT-receive callbacks — inbound-token surface that
     directly contradicts this set's I4 "no funds/tokens, ever, no `receive`" posture), and it's a
     general-purpose arbitrary-`(target, value, calldata)` executor with a 4-role model
     (PROPOSER/EXECUTOR/CANCELLER/DEFAULT_ADMIN). It would be the **first external dependency anywhere
     in the contract set**.
   - **(b) a narrow custom two-step** scoped to exactly the three admin ops (`ADD_WRITER`,
     `REMOVE_WRITER`, `TRANSFER_ADMIN`): `propose(kind, target)` → fixed `timelockDelay` →
     `execute(kind, target)`, plus `cancel`, keyed by `opId = keccak256(abi.encode(kind, target))`.

   **Chosen (b).** For a need this narrow, TimelockController's generality is unused attack surface,
   its token-receiver mixins are actively unwanted under I4, and adding a first external dep diverges
   from the repo's hand-written, zero-dependency discipline. The custom timelock is ~40 lines of
   logic and is fuzzed + invariant-tested with the same rigor as everything else. **The property that
   holds and is tested:** a writer-set change proposed at time T cannot take effect before T + delay,
   under any caller, under any ordering — stated as the adversarially-fuzzed
   `invariant_TimelockNeverExecutesEarly` (with a dedicated attacker that proposes-then-immediately-
   executes every call), not just example tests. It was also demonstrated **on-chain**: on testnet,
   `execute` reverted via a read-only `eth_call` before the delay, then succeeded after a real 60s
   wait.

Events-only design: the only storage is `batchCount` (the §10.3 "batch writer" counter) and the
timelock's `opEta` pending-set. `schemaVersion` is a `constant = 1`, stamped by the contract into
every `ReceiptLogged` so a writer cannot forge it. The §10.3 `ScoreAnchored`/`AuditAnchored` events
are kept **verbatim / non-indexed** per the spec (the `gas-indexed-events` lint is dispositioned over
just those two — see [`slither-triage.md`](slither-triage.md)); `ReceiptLogged`'s three
§10.3-specified indexed topics (`policyId`, `agentId`, `vendorId`) are honored.

## Six judgment calls in UntchVault (§10.4) — resolved, not defaulted

§10.4 leaves six genuinely open calls. Each was resolved deliberately (not by a "more security is
always better" reflex), argued at the definition site in the contract, and summarized here. **One-line
answers first**, reasoning below.

1. **Timelock on `setOracle`/`pause`? → NO — plain owner-gating.**
2. **Hand-rolled ecrecover or a library? → OpenZeppelin `ECDSA` (vendored).**
3. **Naive `transfer` or `SafeERC20`? → `SafeERC20`.**
4. **Is `intentRegistry` mutable? → NO. Is `owner`? → YES, via a two-step transfer.**
5. **Can the cross-contract intent check ever fail open? → NO — it fails closed, no try/catch.**
6. **Where does the token transfer sit? → strictly last (checks-effects-interactions).**

### 1 — No timelock on `setOracle`/`pause` (unlike §10.3 UntchReceipts)

UntchReceipts timelocks its admin because a compromised admin key there had **no other** way to cause
damage than the writer set — the timelock was its only damage-limiter. The vault is different:
`ownerWithdraw` is **unconditional by spec** (§7.5 / I4), so a compromised **owner** key already has an
instant, undelayed path to drain everything. A timelock on `setOracle` closes **nothing** against that —
the same key just calls `ownerWithdraw`. The only remaining argument is protecting the *legitimate*
owner from their own hasty misconfiguration, and that argument is weak here: a wrong oracle **cannot
move funds** (it can only authorize spends already bounded by cap/allowlist/nonce/expiry/intent), the
owner can `pause` instantly and re-`setOracle`, so the mistake is fully recoverable. And `pause` is an
**emergency brake** — timelocking it would be a safety *regression* (you cannot delay a stop). So:
plain owner-gating, matching PolicyRegistry's simplicity. Least complexity = smallest attack surface,
which a fund-holding contract prizes most. (Documented as correctable if the deployment's threat model
ever makes owner-key misconfiguration the dominant risk.)

### 2 & 3 — The first external dependency: vendored OpenZeppelin `ECDSA` + `SafeERC20`

This is a deliberate, reasoned reversal of the §10.3 posture — **not** a contradiction of it. §10.3
rejected OpenZeppelin's `TimelockController` under a specific evaluative test: *does the dependency
hold/receive value or add receive-hooks, and is its scope wildly beyond what's needed?* TimelockController
failed that test hard (it inherits `ERC721Holder`+`ERC1155Holder` — inbound-token callbacks that
contradict I4 — and is a general arbitrary-`(target,value,calldata)` executor with a 4-role model). The
**same test** was applied to `ECDSA` and `SafeERC20`, from reading the actual v5.6.1 source:

- **`ECDSA.sol`** — 284 lines, **zero imports**, a stateless `library`, no `receive`/`fallback`/`payable`,
  no token-receive hook, no value custody. Scoped to exactly one problem: signature recovery. It carries
  the audited **malleability guard** (`s ≤ secp256k1n/2`) — and hand-rolled `ecrecover` is one of the
  most common sources of real, exploited signature bugs in this ecosystem (a valid `(r,s,v)` has a second
  valid malleable twin). Importing it is justified **on the same principle** that rejected the timelock,
  not against it.
- **`SafeERC20.sol` + `IERC20`** — a library that moves *other* tokens on the caller's behalf; holds no
  value, no hooks. USDT0 responds as a standard bool-returning ERC20 on-chain (the LayerZero OFT), but
  some real ERC20s (the canonical mainnet USDT) return **no bool** and break naive Solidity. SafeERC20 is
  cheap insurance that removes that entire bug class for any eventual token — same custody-free,
  single-purpose test.

Both **pass** the test that TimelockController **failed**, so both are imported. They are **vendored as
committed files** under [`lib/openzeppelin-contracts/`](lib/openzeppelin-contracts) (verbatim v5.6.1,
commit `5fd1781`, MIT) — **not** a git submodule — so the CI's plain checkout (which relies on the same
no-submodule vendoring as `forge-std`) needs no change, and `lib/` stays excluded from solhint / Slither
/ `forge fmt`. A one-line [`remappings.txt`](remappings.txt) maps `@openzeppelin/contracts/`. The
EIP-712 **digest** itself is built in-contract with the standard `keccak256(0x1901 ‖ domainSeparator ‖
structHash)` — digest construction is not where malleability bugs live, so no library is needed there.

### 4 — `intentRegistry` + token allowlist immutable; `owner` rotatable (two-step)

§10.4's setter list (`setOracle`, `setFallbackAllowlist`) omits changing which IntentRegistry the vault
trusts, the token allowlist, and the owner. The right reading is **not** "no setter ⇒ blanket
immutable" — it's *trust-redirection-prevention*, and that cuts differently for the three:

- **`intentRegistry` and the token allowlist are `immutable`.** A mutable one would let the vault's
  cross-contract trust (or its spendable-token set) be **silently redirected to a third party** — an
  attack surface. Immutability there *adds* security. No setter, set once at construction.
- **`owner` is rotatable, via a two-step transfer** (`transferOwnership` → `acceptOwnership`, with
  `pendingOwner`). This was a **distinct decision**, not the registry reasoning applied blindly: letting
  the sovereign rotate its **own** key adds **no** attacker capability — a *compromised* owner key is
  already total via the unconditional `ownerWithdraw`, so `transferOwnership` hands an attacker nothing.
  What immutability there would cost is severe and one-directional: a **lost** owner key (a dropped
  device, not a theft) would permanently strand the vault's principal, with no rotation path. The
  two-step handshake means ownership can never be transferred to a wrong/dead address that cannot claim
  it; passing the zero address cancels a pending transfer. (If the owner is a multisig/smart-account that
  rotates its signers internally, it simply never uses this — the capability costs nothing unused.)

### 5 — The cross-contract check fails **closed**

When `requireAnchoredIntent` is true, `spend` calls `intentRegistry.isUsable(intentHash)` as a **plain
typed call — never wrapped in try/catch**. Any failure — a revert, a no-code address, short/garbage
return data — propagates as a **full revert of the entire spend**. This is the single most important
property in the contract (I2 fail-closed, applied to money). It is fuzzed/asserted against a
**reverting** registry, an **empty-return** registry, a **dirty-bool-return** registry, and a
**no-code** address — each confirming the whole spend reverts **and** that funds are unmoved, the nonce
unused, and epoch accounting untouched (`test_CrossContract_*_FailsClosed`). Because `isUsable` is
`view`, Solidity compiles it to a `STATICCALL`, so a malicious registry can't even reenter.

### 6 — Checks-effects-interactions

The cross-contract read **and** all state mutations (nonce marked used, epoch accounting committed)
happen **before** the token transfer, which is **strictly the last operation** in both spend paths. Stated
as an explicit invariant and tested two ways: the reentrancy-guard test (a reentrant token cannot
double-spend) **and** a guard-*independent* CEI test (`test_Spend_EffectsCommittedBeforeTransfer_CEI`) —
a probe token reads the vault's `epochSpent`/`nonceUsed` *during* the transfer (view getters aren't
guard-blocked) and confirms the effects were already committed, so a CEI regression would be caught even
if the reentrancy guard were still present.

### Also specified explicitly (not guessed)

- **Dynamic chainId in the EIP-712 domain.** The domain separator binds `block.chainid` (cached at
  construction, **recomputed on fork** if `block.chainid` changes) and `address(this)` — never a
  hardcoded chainId that would enable cross-chain signature replay once the same bytecode is deployed to
  mainnet. Domain name is **`UntchVault`** (not the older AgentSpendVault); domain is
  `UntchVault(chainId, vault)` per §10.4 (name + chainId + verifying contract, no `version`). Tested by
  `test_DomainSeparator_RecomputesOnChainIdChange` and `test_Spend_CrossChainReplayRejected`.
- **Nonce uniqueness on the signed `nonce` FIELD** (`nonceUsed[nonce]`), never derived from signature
  bytes — so signature malleability cannot mint a second usable authorization.
- **Epoch rollover** is fuzzed at the exact boundary (`ts == genesis + epochLen`), not just inside an
  epoch; `epochSpent` resets exactly on rollover, monotone within an epoch.

### The fallback path (`spendFallback`) — exact guard enumeration (NOT an addendum)

`spendFallback` is a **second, mostly-parallel spend path** for when the oracle is offline, with its own
full test battery. It is **owner-only**: it grants no capability the owner doesn't already have via the
unconditional `ownerWithdraw`, so gating it to the owner preserves I4 exactly while adding
allowlist/budget/token discipline and an auditable `VaultSpend` receipt to owner contingency spends.

| Guard | Oracle path (`spend`) | Fallback path (`spendFallback`) |
|-------|----------------------|--------------------------------|
| **paused** blocks it | ✅ yes (`VaultPaused`) | ✅ **yes** (`VaultPaused`) |
| **token allowlist** | ✅ yes (`TokenNotAllowed`) | ✅ **yes** (`TokenNotAllowed`) |
| **epoch budget** (shared `epochSpent`) | ✅ yes (`BudgetExceeded`) | ✅ **yes** (`BudgetExceeded`) |
| oracle EIP-712 signature | ✅ required | ⛔ **substituted** |
| single-use nonce | ✅ required | ⛔ **substituted** |
| signature expiry | ✅ required | ⛔ **substituted** |
| APPROVED anchored intent | ✅ when required | ⛔ **substituted** |
| per-tx bound | global `perTxCap` | **per-recipient** `fallbackPerTxMax` (owner-preset) |
| caller | permissionless (sig is the capability) | **owner-only** |

The oracle signature / nonce / expiry / intent-approval are replaced by the **owner-pre-committed
per-recipient allowlist cap** — the oracle being offline is the whole premise of this path existing. Both
paths share one `epochSpent`, so the epoch budget bounds total outflow across **both**
(`test_Fallback_SharesEpochBudgetWithOraclePath`). Confirmed: **pause blocks both spend paths but never
`ownerWithdraw`** (`test_OwnerWithdraw_WorksWhilePaused`).

### The master invariant (§10.4 verbatim, as ONE property)

> No token leaves the vault under any circumstance **except**: a valid unexpired unused oracle sig **∧**
> caps hold **∧** (anchored-intent APPROVED if required), **OR** `ownerWithdraw`, **OR** a fallback spend
> within its own bounds.

Stated as a single adversarially-fuzzed equation `vault balance == netDeposited − totalLegitOut` (any
illicit outflow — including a reentrant double-spend — breaks it), with a handler that hammers bad-sig /
over-cap / unapproved-intent / non-owner attempts and an armed reentrant token, plus an `afterInvariant`
liveness gate so it can't pass vacuously.

### Compiler note: `via_ir` was turned ON here

The `foundry.toml` comment reserved `via_ir` for "the first real contract that hits stack-too-deep."
UntchReceipts is it: §10.3's `ReceiptLogged` event has **16 fields** verbatim from the spec, and
emitting all 16 exceeds the legacy pipeline's stack limit even isolated in its own function. `via_ir`
is the exact remedy solc names for stack-too-deep, so it is now enabled. It applies to the whole set
from one config, so it stays **constant across test / static-analysis / deploy** (§28). The
already-deployed PolicyRegistry / SpendIntentRegistry were built + verified under `via_ir = false`
and are not being rebuilt or redeployed.

## `UntchVaultFactory` (§10.4) — one reconciled spec-drift + two judgment calls

The factory is small and single-purpose: it deploys `UntchVault` instances via CREATE2 and predicts
their addresses. It **holds no funds and introduces no money-movement** — there is no
deposit/spend/withdraw path in it; those live only in the vault. Three things needed a real decision,
each resolved deliberately and reflected in the code + tests.

### The spec-drift: §10.4's `deployVault` signature predates the IntentRegistry integration

§10.4 writes the signature as
`deployVault(owner, agent, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow[], requireAnchoredIntent)`.
That text predates the cross-contract wiring the as-built `UntchVault` constructor now requires: its
constructor is
`(owner, oracle, intentRegistry, perTxCap, epochBudget, epochLenSecs, tokenAllow[], requireAnchoredIntent)`
— an **immutable `intentRegistry`** the spec's `deployVault` list never mentions, and it takes **no
`agent`** at all. Two ways to get this wrong: silently bolt `intentRegistry` on as a new `deployVault`
parameter (a signature change), or blindly follow the stale signature and never wire `intentRegistry`
through (a factory that deploys a **broken** vault whose anchored-intent check reverts).

**Reconciliation (neither):** the factory holds ONE canonical `intentRegistry` (below) and injects it
into every vault, so **`deployVault`'s external signature stays byte-for-byte as §10.4 wrote it** — no
new parameter. And `agent`, which the vault constructor doesn't take, is given its real job: the
CREATE2 **salt seed** ("deterministic per agent"). So the reconciliation *adds nothing* to the spec
signature and *loses nothing* the vault needs.

### Judgment call 1 — `intentRegistry` is factory-canonical & immutable (not a per-call parameter)

There is one canonical `SpendIntentRegistry` (§10.2) for the whole system. A per-call `intentRegistry`
would let any caller point a vault at a **rogue registry** — redirecting the vault's cross-contract
trust, the exact attack `UntchVault`'s own judgment call 4 made `intentRegistry` immutable to prevent.
So the factory takes `intentRegistry` **once, at its own construction**, stores it `immutable`, and
uses it for every vault. This lifts "the rules of the game aren't alterable per-instance" from one
vault to the whole fleet a factory mints. A vault deployed with `requireAnchoredIntent == false` still
receives the canonical registry — it simply never calls it. (`test_DeployVault_WiresEveryImmutableFromInputs`
reads the deployed vault's `intentRegistry()` back and asserts it equals the factory's canonical one,
never a caller value.)

### Judgment call 2 — salt = `keccak256(owner, agent)`, and access = permissionless but `owner == msg.sender`

**Salt.** §10.4 says "deterministic per agent," and the hard rule names the **`(owner, agent)` pair**
as the uniqueness key. `agent` in this system is a namespacing seed, not part of the intent identity
(the §8.1 `SpendIntent` identifies agents by `uint256` `buyerAgentId` / `workerAgentId`, and the
vault's sovereign is the `owner` operator wallet). The same `agent` address can legitimately be
operated under **different owners**, so the salt binds both: `keccak256(abi.encode(owner, agent))`.
Same agent, different owner ⇒ distinct vaults (`test_Salt_SameAgentDifferentOwnerGivesDistinctVaults`);
same owner, different agent ⇒ distinct vaults.

**Access control.** §10.4 doesn't restrict who may call `deployVault`, so the open reading is right for
a self-service product: **permissionless — no allowlist, no admin, no fee.** But `owner` must equal the
caller. That one constraint is what makes the deterministic `(owner, agent)` address **non-griefable**:
without it, anyone could deploy *your* vault at *your* address with immutable caps you never chose
(you'd keep custody via `ownerWithdraw`, but you could never place your own config at that address —
it's occupied). Requiring `owner == msg.sender` means only you can ever occupy or vary your own slot
(`test_DeployVault_RevertsWhenOwnerIsNotCaller`, `test_DeployVault_PermissionlessForOnesOwnVault`).
This matches §5.2's "operator deploys UntchVault via factory" — the operator *is* the deployer.

### Double-deployment, and an honest note on what CREATE2 can and can't enforce

Redeploying the same `(owner, agent)` with the **same config** reverts through CREATE2's own behavior:
the target address already holds code, so the EVM's `create2` returns the zero address (no bespoke
pre-check). The factory classifies that zero-return *after the fact* — occupied target ⇒ a clear,
named `VaultAlreadyDeployed(owner, agent)`; otherwise a vault-constructor revert ⇒ `VaultDeploymentFailed`
(`test_DeployVault_DoubleDeploySamePairReverts`).

The honest nuance, surfaced not papered over: a CREATE2 address is
`keccak256(0xff, factory, salt, keccak256(initCode))`, and the vault stores its config as constructor
**immutables**, so the config is part of `initCode`. That means the same `(owner, agent)` with a
**different** config lands at a **different** address — CREATE2 cannot collide distinct initcode, and
no salt scheme can change that while the vault is immutable-configured (a constructor-less clone can't
carry per-instance immutables). This is not a griefing surface: because `owner == msg.sender`, only the
owner itself could ever create such a variant of its own vault
(`test_DeployVault_SamePairDifferentConfigLandsElsewhere` documents the real behavior). Off-chain the
system deploys one canonical config per pair, so "the vault for `(owner, agent)`" stays well-defined.

**Prediction == deployment (no tampering).** `deployVault` and `computeVaultAddress` build the initcode
through a **single shared `_vaultInitCode(...)` helper**, so a prediction can never diverge from where
the deployment lands. `testFuzz_ComputeVaultAddressMatchesDeployment` proves it across 256 random
`(owner, agent, oracle, caps, epochLen, token, requireAnchoredIntent)` tuples, and
`test_ComputeVaultAddress_CommitsToConstructorArgs` proves the address commits to every arg (so you
can't predict with one config and have a differently-configured vault land there). One CREATE2
characteristic worth stating plainly: a *mistaken* same-config redeploy burns most of the caller's
forwarded gas before the guard's clear revert (the EVM consumes the create's gas on an address
collision) — the caller's own gas on a mistake path the deploy driver avoids by predicting first.

## Compiler settings (single source of truth: [`foundry.toml`](foundry.toml))

| Setting | Value | Why |
|---------|-------|-----|
| `solc` | `0.8.34` (exact pin) | latest stable 0.8.x at D0.4; constant across test/deploy |
| `optimizer` / `runs` | `true` / `200` | documented balanced baseline |
| `via_ir` | `true` | ON since UntchReceipts (§10.3): its 16-field `ReceiptLogged` event exceeds the legacy pipeline's stack limit; constant across test/deploy |
| `deny` | `"warnings"` | warnings-as-errors (§28) |
| `evm_version` | `paris` | conservative zkEVM-safe default; **D0 follow-up** to confirm X Layer's exact fork |

Unchanged since D0.4 — one compiler truth for `forge test`, static analysis, and deploy.

## The pipeline (all run in CI — [`.github/workflows/contracts.yml`](../.github/workflows/contracts.yml))

```bash
forge fmt --check                                              # 1. formatting
forge build                                                    # 2. compile (warnings = errors)
forge test                                                     # 3. unit + fuzz + invariant
npm ci && npm run lint                                         # 4. solhint (--max-warnings 0)
slither . --triage-database slither.triage.json --fail-medium  # 5. Slither (Medium/High block)
aderyn --src src/ -o report.json .                             # 6. Aderyn (gate on .issue_count.high)
```

### PolicyRegistry §28 results

| Tier | Result |
|------|--------|
| **Unit** (every function, every revert path) | ✅ green |
| **Fuzz** (policyId injectivity; access control totality; nonce monotonicity; derived expiry) | ✅ green |
| **Invariant / stateful** (owner never changes; only owner mutates; status always valid) | ✅ green — 128k calls/run, 0 non-owner successes |
| **Static — Slither** | ✅ 0 High, 0 Medium; **3 Low** (`timestamp` on intentional expiry comparisons) — dispositioned in [`slither-triage.md`](slither-triage.md) |
| **Static — Aderyn** | ✅ 0 High, **0 Low** |
| **Coverage** | ✅ **100% branch** (11/11) on `PolicyRegistry.sol` — target was ≥95% (see [`coverage-summary.txt`](coverage-summary.txt), [`lcov.info`](lcov.info)) |
| **Gas** | ✅ [`forge snapshot`](.gas-snapshot) committed |
| **Testnet deploy + verify + readback** | ✅ **DONE** — deployed to X Layer testnet (`0xe1d7…3532`), source verified on OKLink, one demo policy registered and read back (independently re-read via raw RPC). [`deploy/README.md`](deploy/README.md), [`deploy/testnet-receipt.json`](deploy/testnet-receipt.json). |

### SpendIntentRegistry §28 results

| Tier | Result |
|------|--------|
| **Unit** (every function, every revert path: non-writer, zero policyId, past/too-far deadline, dup register, setStatus nonexistent/NONE, admin ops) | ✅ green |
| **Fuzz** (registry hash == library == canon `abi.encode` formula; any-field-change changes hash; access-control totality for register/setStatus/admin over random callers) | ✅ green |
| **Invariant / stateful** (only writers ever mutate; core data immutable after registration; status always a real lifecycle state) | ✅ green — 128k calls/run, 0 non-writer successes |
| **Static — Slither** | ✅ 0 High, 0 Medium; **3 Low** (`timestamp` on the intentional derived-expiry comparisons) — dispositioned in [`slither-triage.md`](slither-triage.md) |
| **Static — Aderyn** | ✅ 0 High, **0 Low** |
| **Coverage** | ✅ **100% branch** (13/13) on `SpendIntentRegistry.sol` — target was ≥95% (see [`coverage-summary.txt`](coverage-summary.txt), [`lcov.info`](lcov.info)) |
| **Gas** | ✅ [`forge snapshot`](.gas-snapshot) committed |
| **Testnet deploy + verify + readback** | ✅ **DONE** — deployed to X Layer testnet (`0xf87e…1372`), source verified on OKLink, one demo intent registered + transitioned PENDING→APPROVED and read back (independently re-read via raw RPC, incl. a raw `previewIntentHash` re-proof). [`deploy/README.md`](deploy/README.md), [`deploy/spend-intent-testnet-receipt.json`](deploy/spend-intent-testnet-receipt.json). |

### UntchReceipts §28 results

| Tier | Result |
|------|--------|
| **Unit** (every function, every revert path: non-writer log/anchor, empty batch, zero score root, zero report hash, non-admin propose/execute/cancel, propose NONE-kind / zero-target / already-pending, execute-before-delay / not-found / already-a-writer, cancel not-found, zero-delay constructor) | ✅ green (41 tests) |
| **Fuzz** (batch event count + per-entry field mapping over random sizes — no off-by-one; schemaVersion always 1; batch-counter monotonic; access-control totality for log/anchor/timelock over random callers; execute-before-delay over random delays) | ✅ green |
| **Invariant / stateful** (timelock never executes early — the §10.3 crown jewel, adversarially fuzzed; pending eta mirrors chain; writers change ONLY via executed timelock ops; no unauthorized mutation; batchCount == successful log calls) + an `afterInvariant()` **liveness gate** so none can pass vacuously | ✅ green — 128k calls/run, 0 non-authorized successes, 0 early executes |
| **Static — Slither** | ✅ 0 High, 0 Medium; **1 new Low** (`timestamp` on the `execute` timelock comparison) — dispositioned in [`slither-triage.md`](slither-triage.md) |
| **Static — Aderyn** | ✅ 0 High, **0 Low** |
| **Coverage** | ✅ **100% branch** (14/14) on `UntchReceipts.sol` (and 6/6 on `AuthorizedWriters.sol`) — target was ≥95% |
| **Gas** | ✅ [`forge snapshot`](.gas-snapshot) committed, **plus measured real testnet gas/receipt** (below) |
| **Testnet deploy + verify + readback** | ✅ **DONE** — deployed to X Layer testnet (`0x0c64…4863`), source verified on OKLink ("Pass - Verified"), writer authorized through the real timelock (execute-before-delay reverted on-chain, then executed after a real 60s wait), a 3-receipt batch logged, one score + one audit anchored, all independently re-read via raw RPC. [`deploy/README.md`](deploy/README.md), [`deploy/untch-receipts-testnet-receipt.json`](deploy/untch-receipts-testnet-receipt.json). |

### UntchVault §28 results

| Tier | Result |
|------|--------|
| **Unit** (every function; every §7.5 revert path as its OWN named test: VaultPaused, SigExpired, NonceReplay, BadOracle, CapExceeded, BudgetExceeded, TokenNotAllowed, IntentNotApproved; constructor guards; deposit/withdraw/setOracle/pause/fallback/allowlist; two-step ownership transfer + retarget/cancel/non-owner/non-pending) | ✅ green (74 tests) |
| **Fuzz** (valid-within-bounds spends; wrong-signer rejection over random keys; per-tx cap boundary; epoch boundary AT the rollover second; expiry boundary; **signature malleability** — high-s twin rejected, nonce not consumed; **chainId dynamism** + cross-chain replay) | ✅ green |
| **Cross-contract fail-closed** (judgment call 5 — reverting / empty-return / dirty-bool-return / no-code registry each reverts the WHOLE spend, funds unmoved, nonce unused, epoch untouched) | ✅ green |
| **Reentrancy / CEI** (reentrant token cannot double-spend; **guard-independent CEI probe** proving effects committed before the transfer) | ✅ green |
| **Invariant / stateful** (the §10.4 master no-fund-movement equation, adversarially fuzzed; epoch monotone + resets on rollover; pause blocks spend never withdraw; reentrancy never succeeds) + an `afterInvariant()` **liveness gate** so none pass vacuously | ✅ green — 128k calls/run, 0 illicit outflows, 0 reentries |
| **Static — Slither** | ✅ 0 High, 0 Medium (the original `incorrect-equality` Medium on `epoch == currentEpoch` was **removed by refactor** to `epoch > currentEpoch`, not triaged); `timestamp` **Low** ×3 + `missing-zero-check` **Low** (intentional: `transferOwnership(0)` cancels a pending transfer) + `missing-inheritance` **Informational**, dispositioned in [`slither-triage.md`](slither-triage.md). Two local-only third-party plugin detectors are documented there as false positives (absent from CI). |
| **Static — Aderyn** (0.6.8, the CI version) | ✅ 0 High, 2 Low. A first pass flagged a High "Reentrancy: state change after external call" on `spend()` (a false positive — the intent read is a `view` STATICCALL that can't reenter) — **fixed, not triaged**, by tightening `spend()` to strict CEI (all effects before any external call; intent read moved into the interactions phase). Remaining Lows: "Centralization Risk" (by design — §16 I4) and the `transferOwnership(0)`-cancels zero-check (intentional). See [`slither-triage.md`](slither-triage.md). |
| **Coverage** | ✅ **100% branch** (27/27), 100% lines (113/113), 100% functions (20/20) on `UntchVault.sol` — meets §28's "100% branch on UntchVault" (see [`coverage-summary.txt`](coverage-summary.txt)) |
| **Gas** | ✅ [`forge snapshot`](.gas-snapshot) committed, **plus measured real testnet gas per spend** (`spend` 123,751 · `spendFallback` 73,936) |
| **Testnet deploy + verify + readback** | ✅ **DONE** — deployed to X Layer testnet ([`0x42e6…4848`](https://www.oklink.com/x-layer-testnet/address/0x42e699ffd8215d48397a049b4f7a176db06f4848)), source verified on OKLink ("Pass - Verified"), real deposit → oracle spend anchored to the **real APPROVED §10.2 intent** (cross-contract `isUsable` executed on-chain) → fallback spend → reverted over-cap attempt → ownerWithdraw, all independently re-read via raw `cast`. [`deploy/README.md`](deploy/README.md), [`deploy/untch-vault-testnet-receipt.json`](deploy/untch-vault-testnet-receipt.json). |

### UntchVaultFactory §28 results

| Tier | Result |
|------|--------|
| **Unit** (constructor sets canonical registry + rejects zero registry; `deployVault` wires EVERY vault immutable, read back and MATCHED to inputs; `requireAnchoredIntent == false` still wires the canonical registry; `computeVaultAddress` == real deployed address; address commits to every constructor arg; double-deploy same pair reverts `VaultAlreadyDeployed`; same pair different config lands elsewhere; `owner != caller` reverts `OwnerMustBeSender`; permissionless-for-own-vault; zero-agent reverts; salt distinguishes owner and agent; invalid vault args revert `VaultDeploymentFailed`) | ✅ green (17 tests) |
| **Fuzz** (`computeVaultAddress` == `deployVault` result across 256 random `(owner, agent, oracle, perTxCap, epochBudget, epochLen, token, requireAnchoredIntent)` tuples — address prediction correctness, the §10.4 step-4 property) | ✅ green (256 runs) |
| **Static — Slither** | ✅ 0 High, 0 Medium — factory adds only `assembly` (the deliberate `create2`) + `too-many-digits` (false positive on the embedded vault `creationCode`), both **Informational**, dispositioned in [`slither-triage.md`](slither-triage.md). CI-equivalent detector set exits 0. |
| **Static — Aderyn** (0.6.8, the CI version) | ✅ 0 High. A first pass flagged a High "`abi.encodePacked()` Hash Collision" on the initcode build — a false positive (fixed-length `creationCode` prefix + self-delimiting `abi.encode`) — **fixed, not triaged**, by switching to `bytes.concat` (byte-identical output; every predicted/deployed address unchanged, proven by the fuzz test). See [`slither-triage.md`](slither-triage.md). |
| **Coverage** | ✅ **100% branch** (5/5), 100% functions (6/6), 96.15% statements (25/26), 95.83% lines (23/24) on `UntchVaultFactory.sol` — the single uncovered line is the `create2` opcode **inside the `assembly` block**, which `forge coverage` cannot instrument (it is exercised by every deploy test). Exceeds §28's ≥95% branch bar (see [`coverage-summary.txt`](coverage-summary.txt)). |
| **Gas** | ✅ [`forge snapshot`](.gas-snapshot) committed; **measured real testnet `deployVault` gas: 1,161,751** |
| **Testnet deploy + verify + readback** | ✅ **DONE** — factory deployed to X Layer testnet ([`0x1562…b7e9`](https://www.oklink.com/x-layer-testnet/address/0x1562c6eb1813016c8562cf6771cbf715007bb7e9), source **verified** on OKLink "Pass - Verified"); a real **predict** (`computeVaultAddress` → `0x84BA…8975`, 0 code) **→ deploy** (`deployVault`, tx `0xdcb7…ccf9`) **→ prediction-match** (4940 bytes at the predicted address) **→ independent raw-`cast` readback of the deployed vault's immutables** (owner/oracle/**canonical intentRegistry**/perTxCap/epochBudget/epochLen/requireAnchoredIntent/tokenAllowed — all match inputs) **→ `VaultAlreadyDeployed` + `OwnerMustBeSender` reverts proven on-chain**. [`deploy/untch-vault-factory-testnet-receipt.json`](deploy/untch-vault-factory-testnet-receipt.json). |

> **The on-chain contract set is now COMPLETE.** `UntchVaultFactory` is the fifth and final contract
> in PRD §10 (PolicyRegistry §10.1 · SpendIntentRegistry §10.2 · UntchReceipts §10.3 · UntchVault §10.4 ·
> UntchVaultFactory §10.4). **All five are built, tested through the full §28 pipeline, and live +
> verified on X Layer testnet.** **Mainnet remains deliberately deferred** (PRD §22.4): nothing touches
> X Layer mainnet until all five clear §28's mainnet checklist **together**.

### Measured gas/receipt (real X Layer testnet txs) — fulfilling §17 / §25 / §10.4

This is the contract §10.4 was waiting on: *"anchoring cost is designed-to-be-minimal (events-only,
batched); measured gas/receipt on X Layer will be published after deployment — no cost claims before
measurement."* Here is the measurement, from real testnet `logReceipts` transactions:

| Batch size | Total gasUsed | Gas / receipt |
|-----------:|--------------:|--------------:|
| 1 | 42,109 | 42,109 |
| 10 | 149,270 | 14,927 |
| 50 | 658,610 | 13,172 |

**Marginal gas/receipt (50 vs 10): ≈ 12,734.** Batching amortizes the fixed per-tx overhead (~21k
intrinsic + the batch-counter `SSTORE` + the `BatchLogged` event) across the batch — ~42k/receipt at
size 1 down to ~13k/receipt at size 50.

- **Slither** triage: accepted Medium/High findings must be justified in
  [`slither-triage.md`](slither-triage.md); `slither.triage.json` is the (empty) machine database.
  Optimization / Informational / **Low** findings do not block CI.
- **Aderyn** blocks on any High.

## Off-chain `policyHash`

Computed with `@untch/canon`'s `hashCanonicalJson` (RFC-8785 canonical JSON → keccak256) — the
same surface [`services/asp/src/policy-fixture.ts`](../services/asp/src/policy-fixture.ts) uses, so
the ruleset the ASP enforces and the ruleset anchored on-chain are the same bytes. The registry
stores `policyHash` as an opaque `bytes32`; it never recomputes it.

## Deploy

Testnet-only. See [`deploy/README.md`](deploy/README.md),
[`scripts/deploy-policy-registry.ts`](../scripts/deploy-policy-registry.ts),
[`scripts/deploy-spend-intent-registry.ts`](../scripts/deploy-spend-intent-registry.ts),
[`scripts/deploy-untch-receipts.ts`](../scripts/deploy-untch-receipts.ts),
[`scripts/deploy-untch-vault.ts`](../scripts/deploy-untch-vault.ts), and
[`scripts/deploy-untch-vault-factory.ts`](../scripts/deploy-untch-vault-factory.ts).

## Layout

```
src/PolicyRegistry.sol           first real product contract (PRD §10.1)
src/SpendIntentRegistry.sol      second real product contract (PRD §10.2)
src/UntchReceipts.sol            third real product contract (PRD §10.3) — receipts log + admin timelock
src/UntchVault.sol               fourth real product contract (PRD §10.4/§7.5) — fund-holding spend vault
src/UntchVaultFactory.sol        fifth real product contract (PRD §10.4) — CREATE2 factory for UntchVault
src/AuthorizedWriters.sol        shared admin/writer allowlist base (§10.2 + §10.3)
src/lib/IntentHash.sol           D0.5 SpendIntent hash (canonicalization differential; reused by §10.2)
lib/openzeppelin-contracts/      vendored OZ v5.6.1 (ECDSA + SafeERC20 + IERC20 closure), committed, no submodule
test/UntchVault.t.sol            unit + per-function fuzz + malleability/CEI/cross-contract-fail-closed
test/UntchVault.invariant.t.sol  adversarial master-invariant + epoch + reentrancy + liveness gate
test/UntchVaultFactory.t.sol     unit (wiring readback, double-deploy, access control) + address-prediction fuzz
test/mocks/VaultMocks.sol        ERC20 (standard / no-return / reentrant / CEI-probe) + registry mocks
remappings.txt                   @openzeppelin/contracts/ → lib/openzeppelin-contracts/contracts/
test/PolicyRegistry.t.sol        unit + per-function fuzz
test/PolicyRegistry.invariant.t.sol       handler-based stateful invariants
test/SpendIntentRegistry.t.sol            unit + per-function fuzz
test/SpendIntentRegistry.invariant.t.sol  handler-based stateful invariants
test/UntchReceipts.t.sol                  unit + per-function fuzz
test/UntchReceipts.invariant.t.sol        adversarial timelock invariants + liveness gate
test/IntentHash.t.sol            JS↔Solidity hash differential
foundry.toml                     pinned compiler + fmt config
.solhint.json                    lint config
slither.config.json              Slither config (fail_on=medium, excludes lib/)
slither.triage.json              Slither triage database (empty — nothing Medium/High to accept)
slither-triage.md                triage policy + written dispositions (§28)
deploy/                          testnet deploy runbooks + local proof receipts
```

D0.4 evidence and decisions: [`internal/day0/D0.4-toolchain-notes.md`](../internal/day0/D0.4-toolchain-notes.md).
