# Untch contracts

Solidity contracts for Untch, built with [Foundry](https://book.getfoundry.sh/) and gated by the
PRD §28 audit & test pipeline. The toolchain was stood up in **D0.4** on a throwaway scaffold; the
canonicalization differential landed in **D0.5**. This directory now holds the **first real
product contract**, [`PolicyRegistry`](src/PolicyRegistry.sol), which is the first to go through
the full §28 pipeline for real.

*Public proof. Private work. Accountable payment.*

## What's real here

| Path | What it is | Status |
|------|-----------|--------|
| [`src/PolicyRegistry.sol`](src/PolicyRegistry.sol) | PRD §10.1 — on-chain anchor: a committed ruleset (`policyHash`) governed a given agent at a given time. Owner-gated register / update / pause / resume, event per mutation. | **Real & LIVE on X Layer testnet** at [`0xe1d7…3532`](https://www.oklink.com/x-layer-testnet/address/0xe1d74c90801db0fa806c72eb818b7671b8233532) (verified source; one demo policy registered + read back). Full §28 pipeline green. See [`deploy/README.md`](deploy/README.md). |
| [`src/lib/IntentHash.sol`](src/lib/IntentHash.sol) | PRD §8.1 SpendIntent struct hash; the Solidity half of the D0.5 canonicalization differential. | Real library. |
| `src/Scaffold.sol` | The D0.4 throwaway ownable/pausable stub. | **Removed** — a real contract (`PolicyRegistry`) now exercises the same CI, so the scaffold's only remaining effect was analyzer noise. (Same call Step-1b made about `ping_untch`.) |

> **No fund custody (I4).** `PolicyRegistry` holds no funds — no `payable`, no `receive`, no
> `fallback`, no deposit/withdraw. It stores hashes and metadata only, by construction.

> **Mainnet is deliberately deferred.** Nothing here touches X Layer **mainnet** until
> `IntentRegistry` / `UntchReceipts` / `UntchVault` also exist and the full contract set clears
> §28's mainnet checklist together (PRD §22.4). Everything below is **testnet-only**.

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

Testnet-only. See [`deploy/README.md`](deploy/README.md) and
[`scripts/deploy-policy-registry.ts`](../scripts/deploy-policy-registry.ts).

## Layout

```
src/PolicyRegistry.sol           first real product contract (PRD §10.1)
src/lib/IntentHash.sol           D0.5 SpendIntent hash (canonicalization differential)
test/PolicyRegistry.t.sol        unit + per-function fuzz
test/PolicyRegistry.invariant.t.sol  handler-based stateful invariants
test/IntentHash.t.sol            JS↔Solidity hash differential
foundry.toml                     pinned compiler + fmt config
.solhint.json                    lint config
slither.config.json              Slither config (fail_on=medium, excludes lib/)
slither.triage.json              Slither triage database (empty — nothing Medium/High to accept)
slither-triage.md                triage policy + written dispositions (§28)
deploy/                          testnet deploy runbook + local proof receipt
```

D0.4 evidence and decisions: [`internal/day0/D0.4-toolchain-notes.md`](../internal/day0/D0.4-toolchain-notes.md).
