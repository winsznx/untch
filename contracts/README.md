# Untch contracts

Solidity contracts for Untch, built with [Foundry](https://book.getfoundry.sh/) and gated by the
PRD §28 audit & test pipeline. The toolchain was stood up in **D0.4** on a throwaway scaffold; the
canonicalization differential landed in **D0.5**. This directory now holds the first three **real
product contracts** — [`PolicyRegistry`](src/PolicyRegistry.sol) (§10.1),
[`SpendIntentRegistry`](src/SpendIntentRegistry.sol) (§10.2), and
[`UntchReceipts`](src/UntchReceipts.sol) (§10.3) — plus the shared
[`AuthorizedWriters`](src/AuthorizedWriters.sol) access-control base, each taken through the full §28
pipeline for real and deployed + verified on X Layer testnet.

*Public proof. Private work. Accountable payment.*

## What's real here

| Path | What it is | Status |
|------|-----------|--------|
| [`src/PolicyRegistry.sol`](src/PolicyRegistry.sol) | PRD §10.1 — on-chain anchor: a committed ruleset (`policyHash`) governed a given agent at a given time. Owner-gated register / update / pause / resume, event per mutation. | **Real & LIVE on X Layer testnet** at [`0xe1d7…3532`](https://www.oklink.com/x-layer-testnet/address/0xe1d74c90801db0fa806c72eb818b7671b8233532) (verified source; one demo policy registered + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/SpendIntentRegistry.sol`](src/SpendIntentRegistry.sol) | PRD §10.2 — on-chain lifecycle anchor: `intentHash ⇒ {policyId, maxAmount, deadline, status}`. `intentHash` derived on-chain from the §8.1 struct via `IntentHash`; **authorized-writer-set** register / setStatus; status ∈ {PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED} with derived expiry. | **Real & LIVE on X Layer testnet** at [`0xf87e…1372`](https://www.oklink.com/x-layer-testnet/address/0xf87e50f83172c2dace7d274e4c701212caeb1372) (verified source; one demo intent registered + transitioned + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/UntchReceipts.sol`](src/UntchReceipts.sol) | PRD §10.3 — the versioned, **events-only** public receipt log: `logReceipts` (batch), `anchorScore`, `anchorAudit`, all writer-gated; admin writer-set changes behind a **timelock**. On-chain carries hashes/metadata only. | **Real & LIVE on X Layer testnet** at [`0x0c64…4863`](https://www.oklink.com/x-layer-testnet/address/0x0c64997277b7d94d2999dea22a123cac56334863) (verified source; a real 3-receipt batch logged, one score + one audit anchored, writer authorized through the real timelock, independently read back via raw RPC). Full §28 pipeline green. **Measured gas/receipt published** (see below). |
| [`src/AuthorizedWriters.sol`](src/AuthorizedWriters.sol) | Shared admin-managed authorized-writer allowlist (admin/writer roles, add/remove/transfer, events, errors, modifiers) — **extracted** from SpendIntentRegistry. Internal-only mutators so each derived contract chooses its surface (immediate vs timelocked). | Real base. Used by `SpendIntentRegistry` (immediate admin) and `UntchReceipts` (timelocked admin). |
| [`src/lib/IntentHash.sol`](src/lib/IntentHash.sol) | PRD §8.1 SpendIntent struct hash; the Solidity half of the D0.5 canonicalization differential. Reused by `SpendIntentRegistry` to derive `intentHash` on-chain. | Real library. |
| `src/Scaffold.sol` | The D0.4 throwaway ownable/pausable stub. | **Removed** — a real contract (`PolicyRegistry`) now exercises the same CI, so the scaffold's only remaining effect was analyzer noise. (Same call Step-1b made about `ping_untch`.) |

> **No fund custody (I4).** `PolicyRegistry`, `SpendIntentRegistry`, and `UntchReceipts` hold no funds
> — no `payable`, no `receive`, no `fallback`, no deposit/withdraw. They store hashes and metadata
> only, by construction. All three are pure registries/logs.

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

### Compiler note: `via_ir` was turned ON here

The `foundry.toml` comment reserved `via_ir` for "the first real contract that hits stack-too-deep."
UntchReceipts is it: §10.3's `ReceiptLogged` event has **16 fields** verbatim from the spec, and
emitting all 16 exceeds the legacy pipeline's stack limit even isolated in its own function. `via_ir`
is the exact remedy solc names for stack-too-deep, so it is now enabled. It applies to the whole set
from one config, so it stays **constant across test / static-analysis / deploy** (§28). The
already-deployed PolicyRegistry / SpendIntentRegistry were built + verified under `via_ir = false`
and are not being rebuilt or redeployed.

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
[`scripts/deploy-spend-intent-registry.ts`](../scripts/deploy-spend-intent-registry.ts), and
[`scripts/deploy-untch-receipts.ts`](../scripts/deploy-untch-receipts.ts).

## Layout

```
src/PolicyRegistry.sol           first real product contract (PRD §10.1)
src/SpendIntentRegistry.sol      second real product contract (PRD §10.2)
src/UntchReceipts.sol            third real product contract (PRD §10.3) — receipts log + admin timelock
src/AuthorizedWriters.sol        shared admin/writer allowlist base (§10.2 + §10.3)
src/lib/IntentHash.sol           D0.5 SpendIntent hash (canonicalization differential; reused by §10.2)
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
