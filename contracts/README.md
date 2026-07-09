# Untch contracts

Solidity contracts for Untch, built with [Foundry](https://book.getfoundry.sh/) and gated by the
PRD §28 audit & test pipeline. The toolchain was stood up in **D0.4** on a throwaway scaffold; the
canonicalization differential landed in **D0.5**. This directory now holds the first two **real
product contracts**, [`PolicyRegistry`](src/PolicyRegistry.sol) (§10.1) and
[`SpendIntentRegistry`](src/SpendIntentRegistry.sol) (§10.2), each taken through the full §28
pipeline for real and deployed + verified on X Layer testnet.

*Public proof. Private work. Accountable payment.*

## What's real here

| Path | What it is | Status |
|------|-----------|--------|
| [`src/PolicyRegistry.sol`](src/PolicyRegistry.sol) | PRD §10.1 — on-chain anchor: a committed ruleset (`policyHash`) governed a given agent at a given time. Owner-gated register / update / pause / resume, event per mutation. | **Real & LIVE on X Layer testnet** at [`0xe1d7…3532`](https://www.oklink.com/x-layer-testnet/address/0xe1d74c90801db0fa806c72eb818b7671b8233532) (verified source; one demo policy registered + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/SpendIntentRegistry.sol`](src/SpendIntentRegistry.sol) | PRD §10.2 — on-chain lifecycle anchor: `intentHash ⇒ {policyId, maxAmount, deadline, status}`. `intentHash` derived on-chain from the §8.1 struct via `IntentHash`; **authorized-writer-set** register / setStatus; status ∈ {PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED} with derived expiry. | **Real & LIVE on X Layer testnet** at [`0xf87e…1372`](https://www.oklink.com/x-layer-testnet/address/0xf87e50f83172c2dace7d274e4c701212caeb1372) (verified source; one demo intent registered + transitioned + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/lib/IntentHash.sol`](src/lib/IntentHash.sol) | PRD §8.1 SpendIntent struct hash; the Solidity half of the D0.5 canonicalization differential. Reused by `SpendIntentRegistry` to derive `intentHash` on-chain. | Real library. |
| `src/Scaffold.sol` | The D0.4 throwaway ownable/pausable stub. | **Removed** — a real contract (`PolicyRegistry`) now exercises the same CI, so the scaffold's only remaining effect was analyzer noise. (Same call Step-1b made about `ping_untch`.) |

> **No fund custody (I4).** `PolicyRegistry` and `SpendIntentRegistry` hold no funds — no `payable`,
> no `receive`, no `fallback`, no deposit/withdraw. They store hashes and metadata only, by
> construction. Both are pure registries.

> **Mainnet is deliberately deferred.** Nothing here touches X Layer **mainnet** until
> `UntchReceipts` / `UntchVault` also exist and the full contract set clears §28's mainnet checklist
> together (PRD §22.4). Everything below is **testnet-only**.

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
- **Admin behind a timelock** (§10.3): move the `admin` role behind a timelock + rotation runbook
  before mainnet, rather than the plain admin used for this first testnet pass.

## Compiler settings (single source of truth: [`foundry.toml`](foundry.toml))

| Setting | Value | Why |
|---------|-------|-----|
| `solc` | `0.8.34` (exact pin) | latest stable 0.8.x at D0.4; constant across test/deploy |
| `optimizer` / `runs` | `true` / `200` | documented balanced baseline |
| `via_ir` | `false` | legacy pipeline is sufficient; kept explicit and constant |
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
[`scripts/deploy-policy-registry.ts`](../scripts/deploy-policy-registry.ts), and
[`scripts/deploy-spend-intent-registry.ts`](../scripts/deploy-spend-intent-registry.ts).

## Layout

```
src/PolicyRegistry.sol           first real product contract (PRD §10.1)
src/SpendIntentRegistry.sol      second real product contract (PRD §10.2)
src/lib/IntentHash.sol           D0.5 SpendIntent hash (canonicalization differential; reused by §10.2)
test/PolicyRegistry.t.sol        unit + per-function fuzz
test/PolicyRegistry.invariant.t.sol       handler-based stateful invariants
test/SpendIntentRegistry.t.sol            unit + per-function fuzz
test/SpendIntentRegistry.invariant.t.sol  handler-based stateful invariants
test/IntentHash.t.sol            JS↔Solidity hash differential
foundry.toml                     pinned compiler + fmt config
.solhint.json                    lint config
slither.config.json              Slither config (fail_on=medium, excludes lib/)
slither.triage.json              Slither triage database (empty — nothing Medium/High to accept)
slither-triage.md                triage policy + written dispositions (§28)
deploy/                          testnet deploy runbooks + local proof receipts
```

D0.4 evidence and decisions: [`internal/day0/D0.4-toolchain-notes.md`](../internal/day0/D0.4-toolchain-notes.md).
