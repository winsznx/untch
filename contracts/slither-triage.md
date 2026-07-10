# Slither triage & cross-tool disposition — PRD §28

This file is the human-readable companion to [`slither.triage.json`](slither.triage.json).

## The rule (PRD §28)

CI runs `slither . --triage-database slither.triage.json --fail-medium`, so **CI fails on any
Slither finding of Medium or High impact** unless that exact finding is accepted in
`slither.triage.json` with a written justification here. Optimization / Informational / **Low**
findings do **not** block CI (§28: "fail CI on High/Medium").

To accept a Medium/High finding, run `slither . --triage-database slither.triage.json
--triage-mode`; Slither appends an entry keyed by its stable finding hash. Add the justification,
reviewer, and date in this file. Never accept a finding without a written justification.

Cross-tool rule (§28): any finding one of Slither/Aderyn raises and the other does not gets a
written disposition here — no silent disagreement.

## Why `slither.triage.json` is now `[]` (a repair, not a widening)

D0.4 shipped this file carrying JSON *documentation objects* (prose with no `id`/`description`
keys), on the belief that Slither's loader ignores array elements lacking an `id`. That is **not
true** for Slither `0.11.5`: `SlitherCore.valid_result` reads `pr["description"]` for **every**
element loaded from the triage database. With the D0.4 Scaffold there were zero findings, so
`valid_result` was never reached and the malformed entries were harmless. The moment a real
contract (`PolicyRegistry`) produced its first finding, Slither crashed with
`KeyError: 'description'`.

The fix is the correct shape for a triage database: machine-format only, and **empty** because
there is nothing Medium/High to accept. All human documentation lives in this `.md` instead.

## Current dispositions (PolicyRegistry + SpendIntentRegistry + UntchReceipts + UntchVault + UntchVaultFactory)

| # | Finding | Tool | Impact | Disposition |
|---|---------|------|--------|-------------|
| 1 | `timestamp` — `PolicyRegistry.registerPolicy` compares `expiry <= block.timestamp` | Slither | **Low** | Accepted — intentional. Expiry is inherently a wall-clock deadline (§10.1); validator timestamp skew is bounded to seconds while policy lifetimes are days/years, and no value or ordering depends on the exact expiry second. Non-blocking (Low). |
| 2 | `timestamp` — `PolicyRegistry.updatePolicy` compares `newExpiry <= block.timestamp` | Slither | **Low** | Accepted — same rationale as #1. |
| 3 | `timestamp` — `PolicyRegistry.isUsable` computes `block.timestamp <= expiry` | Slither | **Low** | Accepted — this is the derived-usability rule PRD §10.1 mandates verbatim (`status == ACTIVE && block.timestamp <= expiry`). Non-blocking (Low). |
| 4 | `timestamp` — `SpendIntentRegistry.registerIntent` compares `deadline <= block.timestamp` | Slither | **Low** | Accepted — same rationale as #1. The intent `deadline` is a wall-clock bound (§8.1 / §10.2); registration only rejects a deadline already at or behind the current second, and second-scale validator skew is immaterial to a real deadline. Non-blocking (Low). |
| 5 | `timestamp` — `SpendIntentRegistry.isExpired` computes `block.timestamp > deadline` | Slither | **Low** | Accepted — this IS the derived-expiry rule PRD §10.2 requires: expiry is computed at read time, never a stored/transitioned `EXPIRED` state. Non-blocking (Low). |
| 6 | `timestamp` — `SpendIntentRegistry.isUsable` computes `block.timestamp <= deadline` (with `status == APPROVED`) | Slither | **Low** | Accepted — the derived usability rule the vault (§7.5) turns on, the intent analogue of PolicyRegistry's `isUsable`. Non-blocking (Low). |
| 7 | `timestamp` — `UntchReceipts.execute` compares `nowTs < eta` | Slither | **Low** | Accepted — intentional. This IS the §10.3 admin timelock: an op cannot execute before `eta = proposeTime + timelockDelay`. The comparison is the enforcement point of judgment call 3 (proven by the adversarially-fuzzed `invariant_TimelockNeverExecutesEarly`). Second-scale validator skew is immaterial to a timelock delay of minutes/days. `propose` uses `block.timestamp` only in the arithmetic `eta = now + delay` (not a comparison), so Slither does not flag it — consistent. Non-blocking (Low). |
| 8 | `timestamp` — `UntchVault.spend` compares `nowTs > expiry` and `wouldBe > epochBudget` | Slither | **Low** | Accepted — the §7.5 signature-expiry and epoch-budget guards. Expiry is a wall-clock deadline the oracle sets (≤10min per §16); the epoch-budget comparison is arithmetic on an amount, flagged only because `wouldBe` derives from the timestamp-selected `rolledSpent`. Second-scale skew is immaterial to a minutes-scale sig expiry. Non-blocking (Low). |
| 9 | `timestamp` — `UntchVault.spendFallback` compares `wouldBe > epochBudget` | Slither | **Low** | Accepted — same epoch-budget guard as #8 on the fallback path (shared epoch accounting). Non-blocking (Low). |
| 10 | `timestamp` — `UntchVault._epochView` computes the epoch index and `epoch > currentEpoch` | Slither | **Low** | Accepted — the derived epoch-rollover rule (§10.4 epoch accounting): `epoch = (now - epochGenesis) / epochLen`, reset iff a strictly later epoch. This is the vault analogue of the registries' derived-expiry `isUsable`. Non-blocking (Low). |
| 11 | `missing-inheritance` — `SpendIntentRegistry` "should inherit from `ISpendIntentStatus`" | Slither | **Informational** | Accepted — coincidental signature match. `ISpendIntentStatus` (declared in `UntchVault.sol`) is the narrow typed view of the registry the vault calls (`isUsable(bytes32)`); the deployed `SpendIntentRegistry` happens to expose the same signature. Making the shipped, testnet-verified registry `is ISpendIntentStatus` would add a backwards `SpendIntentRegistry → UntchVault` source dependency and change a deployed contract for no behavioral gain. Informational, non-blocking. |
| 12 | `missing-zero-check` — `UntchVault.transferOwnership(newOwner)` sets `pendingOwner = newOwner` without a zero-check | Slither | **Low** | Accepted — intentional. Passing the zero address is the documented way to **cancel** a pending ownership transfer (`pendingOwner = 0` ⇒ nobody can `acceptOwnership`). A zero-check would remove that useful semantics for no safety benefit: this is a two-step transfer, so even a wrong NON-zero `newOwner` cannot take ownership unless it actively calls `acceptOwnership` — there is no "accidentally burned to a dead address" failure mode the check would prevent. Tested by `test_TransferOwnership_ZeroCancelsPending`. Non-blocking (Low). |
| 13 | `assembly` — `UntchVaultFactory.deployVault` uses an inline-assembly `create2` | Slither | **Informational** | Accepted — deliberate and minimal. CREATE2 with a runtime-built initcode blob is expressed with one `create2` opcode over `_vaultInitCode(...)`'s bytes (`create2(0, add(initCode,0x20), mload(initCode), salt)`); high-level Solidity has no equivalent that returns the raw zero-on-collision signal the double-deployment guard classifies. The block is annotated with a written reason and a `solhint-disable-next-line no-inline-assembly`. Informational, non-blocking. |
| 14 | `too-many-digits` — `UntchVaultFactory._vaultInitCode` | Slither | **Informational** | Accepted — false positive. The "literal with too many digits" is `type(UntchVault).creationCode` (the vault's full creation bytecode), not a hand-typed magic number. It is unavoidable — the factory must embed the vault bytecode to CREATE2-deploy it. Informational, non-blocking. |

Slither total (standard detectors, as CI runs them): **0 High, 0 Medium, 11 Low, 3 Informational** —
CI passes under `--fail-medium`, nothing to triage in the machine database.

Findings #8–#10 are the same `timestamp` (block-timestamp) detector class as #1–#7: deliberate,
dispositioned wall-clock comparisons, each read into a `uint256 nowTs` local first for uniformity and
to satisfy the Foundry v1.7.1 block-timestamp build lint. The earlier `incorrect-equality` (Medium)
Slither raised on `_epochView`'s original `epoch == currentEpoch` was **removed by refactor**, not
triaged: because `block.timestamp` is monotonic, `epoch(now) >= currentEpoch` always holds, so the
equivalent `epoch > currentEpoch ? 0 : epochSpent` is an inequality on epoch indices — keeping the
repo's clean **0 Medium** record rather than accepting a Medium.

### Local-only third-party plugin detectors (NOT in the CI gate — recorded to prevent confusion)

A reviewer running Slither locally may have the `tryanneal` detector plugin
(`github.com/winsznx/tryanneal`) installed, which adds non-standard detectors absent from CI's clean
`pipx install slither-analyzer==0.11.5`. Two fire on `UntchVault` and are documented here as
**false positives**, not accepted findings:

- **`signature-replay-bypass` (plugin, High)** — claims `spend` "has no nonce tracking." **False.**
  `spend` does `if (nonceUsed[nonce]) revert NonceReplay(nonce)` then `nonceUsed[nonce] = true`, and the
  EIP-712 digest binds the `nonce` field, `block.chainid`, and `address(this)` (verifying contract), so
  a signature cannot be replayed across nonces, chains, or contracts. The heuristic greps for a
  `nonces[` naming pattern and misses the `nonceUsed` mapping. Rejected — the property is directly
  proven by `test_RevertWhen_Spend_NonceReplay`, `test_Spend_CrossChainReplayRejected`, and the
  invariant suite.
- **`operator-fee-outlier` (plugin, Low)** — a gas-heuristic on the constructor's token-allowlist
  loop. Not a correctness finding; Low; irrelevant to the §28 gate.

Neither is present in CI. Verified: `slither . --triage-database slither.triage.json --fail-medium
--exclude signature-replay-bypass,operator-fee-outlier` (the CI-equivalent detector set) exits **0**.

## solhint dispositions in UntchReceipts (inline, cross-referenced here)

solhint runs `--max-warnings 0`, so intentional deviations are suppressed inline with a written
reason at the deviation (the same discipline PolicyRegistry/SpendIntentRegistry use for
`not-rely-on-time`). UntchReceipts (§10.3) adds two, both spec-fidelity choices, not oversights:

- **`gas-indexed-events`** on `ScoreAnchored` / `AuditAnchored`. Their signatures are VERBATIM from
  §10.3 (non-indexed). The rule would have `epoch`/`subjectKind`/`period` indexed; doing so would
  change how an indexer subscribes and diverge from the given event contract. `ReceiptLogged`'s
  three §10.3-specified indexed topics (`policyId`, `agentId`, `vendorId`) ARE honored. Suppressed
  over just those two events via a scoped `solhint-disable`/`enable` block.
- **`gas-struct-packing`** on the `Receipt` struct. It is calldata-only (never stored), where every
  field occupies a full word regardless of type, so packing yields nothing — and its field order is
  kept 1:1 with the §10.3 `ReceiptLogged` event for mapping clarity. Reordering for "packing" would
  only obscure that mapping. Suppressed at the struct with a written reason.

## Cross-check vs Aderyn

Aderyn (v0.6.x, via the pinned `Cyfrin/aderyn-ci@v0` npm binary) reports **0 High** across the
source set (`PolicyRegistry`, `SpendIntentRegistry`, `IntentHash`, `AuthorizedWriters`,
`UntchReceipts`, `UntchVault`, and now `UntchVaultFactory`); the CI gate is `fail-on: high`. The
`timestamp` (block-timestamp) class above — now 10 Slither Lows — has no Aderyn High counterpart:
expected, and consistent with both tools' severity models.

> **One Aderyn 0.6.8 finding on `UntchVaultFactory` was FIXED, not triaged.** The first local run
> flagged **High — "`abi.encodePacked()` Hash Collision"** on `_vaultInitCode`, which built the CREATE2
> initcode as `abi.encodePacked(type(UntchVault).creationCode, abi.encode(args))`. It was a *false
> positive* for a collision hazard (the creationCode prefix is a compile-time-constant length and
> `abi.encode` is self-delimiting, so no boundary ambiguity exists — this is the canonical CREATE2
> initcode every factory builds) — but rather than carry a High on a fund-adjacent contract, the code was
> changed to `bytes.concat(creationCode, abi.encode(args))`, Aderyn's own recommended form for
> all-`bytes` operands. The output is **byte-identical** (so every predicted/deployed address is
> unchanged — proven by the unchanged `testFuzz_ComputeVaultAddressMatchesDeployment` across 256 random
> inputs), and Aderyn 0.6.8 then reports **0 High**. The remaining `abi.encodePacked` in
> `_computeAddress` (`0xff ++ factory ++ salt ++ initCodeHash`) is NOT flagged — all four operands are
> fixed-width, so there is no collision surface; it is the standard EIP-1014 address preimage.

On `UntchVault`, Aderyn 0.6.8 (the exact `@cyfrin/aderyn@0.6` version the CI action installs, run
locally to reproduce CI) reports **0 High, 2 Low**:

- **Low — "Centralization Risk for trusted owners"** on the `onlyOwner` entry points. **By design, not a
  defect**: §16 I4 makes the `owner` the fund sovereign — it is *supposed* to be able to pause and
  withdraw unconditionally. Accepted (Low, non-blocking; the whole custody model rests on it).
- **Low — "Address State Variable Set Without Checks"** on `transferOwnership`'s `pendingOwner = newOwner`.
  The Aderyn analogue of Slither disposition #12: passing the zero address intentionally cancels a pending
  transfer, and the two-step handshake means a wrong non-zero target cannot take ownership without calling
  `acceptOwnership`. Accepted (Low).

> **One Aderyn 0.6.8 finding was FIXED, not triaged.** The first CI run flagged **High — "Reentrancy:
> State change after external call"** on `spend()`: the anchored-intent read
> `intentRegistry.isUsable(intentHash)` (an external call) was in the checks phase, with the epoch/nonce
> state writes following it. It was a *false positive for reentrancy* (`isUsable` is `view` ⇒ a
> `STATICCALL` that cannot reenter or mutate, plus the `nonReentrant` guard, plus the value transfer is
> strictly last) — but rather than suppress a reentrancy High on a fund-holding contract, `spend()` was
> restructured to **strict CEI**: all state is now committed *before any external call*, with the intent
> read moved into the interactions phase alongside the transfer. Aderyn 0.6.8 then reports **0 High**.
> The behavior is identical (a failed intent check still reverts the whole spend, rolling back the
> effects — proven by the unchanged `test_CrossContract_*_FailsClosed` and CEI tests); only the ordering
> is tightened. This is the deployed + verified bytecode (redeployed after the fix).
