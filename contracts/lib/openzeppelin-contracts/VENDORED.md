# Vendored OpenZeppelin Contracts — provenance & verification

These files are a **partial, verbatim** vendoring of
[OpenZeppelin/openzeppelin-contracts](https://github.com/OpenZeppelin/openzeppelin-contracts),
committed as plain files (NOT a git submodule) so the CI's plain `actions/checkout` needs no submodule
fetch — the same no-submodule vendoring `lib/forge-std` uses. `lib/` is excluded from solhint / Slither
/ `forge fmt`. Only `UntchVault` consumes them, via the `@openzeppelin/contracts/` remapping in
[`../../remappings.txt`](../../remappings.txt).

- **Release tag:** `v5.6.1`
- **Commit:** `5fd1781b1454fd1ef8e722282f86f9293cacf256`
- **License:** MIT (each file keeps its upstream SPDX + header line verbatim)
- **Scope (minimal genuine import closure — no more than needed):** `ECDSA` (signature recovery with the
  `s ≤ secp256k1n/2` malleability guard) and `SafeERC20` + `IERC20`, plus the interface files those
  transitively import (`IERC1363`, `IERC165`, the `interfaces/IERC20` re-export).

## Verified byte-for-byte against the genuine tag — re-runnable

Not trusted on the label. Every file below was diffed byte-for-byte against a fresh fetch from the
canonical upstream tag (`raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.6.1/…`) and is
**identical**. A third corroboration: the testnet `UntchVault` deployment (verified "Pass - Verified" on
OKLink) proves this exact source compiles to the on-chain bytecode.

Re-verify at any time from `contracts/`:

```bash
BASE="https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.6.1/contracts"
for f in utils/cryptography/ECDSA.sol token/ERC20/IERC20.sol token/ERC20/utils/SafeERC20.sol \
         interfaces/IERC1363.sol interfaces/IERC165.sol interfaces/IERC20.sol \
         utils/introspection/IERC165.sol; do
  diff <(curl -fsS "$BASE/$f") "lib/openzeppelin-contracts/contracts/$f" \
    && echo "IDENTICAL  $f" || echo "DIFFERS !! $f"
done
```

## SHA-256 (verified 2026-07-10 against the v5.6.1 tag)

| File | sha256 |
|------|--------|
| `contracts/utils/cryptography/ECDSA.sol` | `ba7c2d314fcd61c9…` |
| `contracts/token/ERC20/IERC20.sol` | `01b6f5c4fa45fd38…` |
| `contracts/token/ERC20/utils/SafeERC20.sol` | `c2394cb2a327f234…` |
| `contracts/interfaces/IERC1363.sol` | `9c3a75a925a6dac9…` |
| `contracts/interfaces/IERC165.sol` | `dfb3f56fa928a7c6…` |
| `contracts/interfaces/IERC20.sol` | `0158e2d3e0e28bed…` |
| `contracts/utils/introspection/IERC165.sol` | `9055c2994b37dea1…` |

(Prefixes shown; the re-verify script above checks the full contents, which is stronger than a prefix.)
