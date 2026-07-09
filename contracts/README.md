# Untch contracts

Solidity contracts for Untch, built with [Foundry](https://book.getfoundry.sh/) and gated by
the PRD §28 audit & test pipeline. This project was stood up in **D0.4** as the toolchain
proving ground; today it holds only a throwaway [`Scaffold`](src/Scaffold.sol) stub, and it is
reused as the project structure for the D0.5 canonicalization spike. The product contracts
(`PolicyRegistry`, `SpendIntentRegistry`, `UntchReceipts`, `UntchVault`) land later and inherit
this same pipeline unchanged.

## Compiler settings (single source of truth: [`foundry.toml`](foundry.toml))

| Setting | Value | Why |
|---------|-------|-----|
| `solc` | `0.8.34` (exact pin) | latest stable 0.8.x available at D0.4; constant across test/deploy |
| `optimizer` / `runs` | `true` / `200` | documented balanced baseline |
| `via_ir` | `false` | legacy pipeline is sufficient; kept explicit and constant |
| `deny` | `"warnings"` | warnings-as-errors (§28) |
| `evm_version` | `paris` | conservative zkEVM-safe default; **D0 follow-up** to confirm X Layer's exact fork |

## The five gates (all run in CI — [`.github/workflows/contracts.yml`](../.github/workflows/contracts.yml))

```bash
forge fmt --check                                              # 1. formatting
forge build                                                    # 2. compile (warnings = errors)
forge test                                                     # 3. tests
npm ci && npm run lint                                         # 4. solhint (--max-warnings 0)
slither . --triage-database slither.triage.json --fail-medium  # 5. Slither (Medium/High block)
aderyn --src src/ -o report.json .                             # 6. Aderyn (gate on .issue_count.high)
```

- **Slither** triage: accepted Medium/High findings must be justified in
  [`slither.triage.json`](slither.triage.json); everything else blocks CI.
- **Aderyn** blocks on any High; Low findings are dispositioned in the report.

## Layout

```
src/Scaffold.sol      throwaway ownable+pausable stub (analyzer surface only)
test/Scaffold.t.sol   unit + revert-path tests
lib/forge-std         vendored (committed) — CI needs no submodule fetch
foundry.toml          pinned compiler + fmt config
.solhint.json         lint config
slither.config.json   Slither config (fail_on=medium, excludes lib/)
slither.triage.json   Slither triage ledger (empty; header documents the rule)
```

D0.4 evidence and decisions: [`internal/day0/D0.4-toolchain-notes.md`](../internal/day0/D0.4-toolchain-notes.md).
