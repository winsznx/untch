# @untch/canon

The deterministic hashing surface shared by the server, middleware, and contracts tests
(PRD §9). Without one tested library, hash mismatches become the #1 bug class — so both
hashing surfaces live here, are cross-checked against standards and against Solidity, and run
in CI on every push (PRD §28 item 5 / Day-0 gate D0.5).

Two surfaces:

- **Surface A — canonical JSON** (policies, acceptance criteria, metadata): RFC 8785 (JCS)
  canonicalization + `keccak256`.
- **Surface B — SpendIntent struct hash** (§8.1): `keccak256(abi.encode(...))` over the 11
  §8.1 fields, differential-tested byte-for-byte against `contracts/src/lib/IntentHash.sol`.

## Numeric policy (the load-bearing decision)

> **All money amounts and all uint256 values are carried in canonical JSON as decimal
> STRINGS of integer base units — never JSON numbers.**

Why: JSON numbers are IEEE-754 doubles. They lose precision above `2^53` (a `uint256` amount
cannot survive one), and different languages serialize the same double differently. A decimal
string of integer base units is exact and language-neutral, so the same amount hashes to the
same bytes everywhere.

- Amounts are normalized to integer **base units** first, using that token's decimals from the
  verified token list (`moneyToBaseUnits(display, decimals)`), e.g. `1.5` USDT (6dp) →
  `"1500000"`.
- `canonUint256(value)` is the runtime guard: it accepts a `bigint` or a decimal string and
  **rejects a JS `number` outright**, so a lossy number can never reach a hash. It is also a
  type error to pass a `number`.

## §9 domain rules (each is a test in `test/domain.test.ts`)

| Rule | Helper | Example |
|---|---|---|
| Addresses lowercased for hashing (EIP-55 is display-only) | `canonAddress` | `0xAbC…` → `0xabc…` |
| Money as integer base-unit **strings** | `moneyToBaseUnits` / `canonUint256` | `1.5` USDT 6dp → `"1500000"` |
| Timestamps ISO-8601 UTC `Z`, second resolution | `canonTimestamp` | `…T20:44:00.123Z` → `2026-07-05T20:44:00Z` |
| URL normalization (lowercase scheme/host, strip default ports, sort query, drop fragment, preserve path case) | `canonUrl` | `HTTPS://H:443/P?b=2&a=1#x` → `https://h/P?a=1&b=2` |

`hashCanonicalJson(value) = keccak256(utf8(canonicalize(value)))`. Callers put domain values
into canonical form with the helpers above **before** hashing.

## RFC 8785 edges resolved

1. **Money as strings, so canonicalization never depends on float serialization at all.** This
   is the numeric policy above. It sidesteps the entire RFC 8785 number-formatting surface
   (`es6testfile`) for every hash we actually take.
2. **Key ordering is by UTF-16 code unit, not code point.** For a non-BMP key like `😀`
   (`U+1F600`, first UTF-16 unit `0xD83D`) versus a BMP key like `U+F8FF`, JCS sorts `😀`
   **first** (`0xD83D < 0xF8FF`) even though by code point it is larger. This is verified
   directly in `test/rfc8785.vectors.test.ts` so the behavior is pinned, not assumed.

## Cross-implementation guarantee

- **Surface A** is proven cross-implementation by conformance: RFC 8785 fixes key order,
  number formatting, and string escaping, so any conforming implementation in any language
  produces the same bytes → the same hash. We wrap the RFC 8785 reference implementation and
  re-run the RFC's own behaviors against the wrapper (`test/rfc8785.vectors.test.ts`).
- **Surface B** is proven by a differential: TS `hashSpendIntent` and Solidity
  `IntentHash.hashIntent` are computed over the same shared corpus (`fixtures/intents.json`)
  and asserted equal for every case (`contracts/test/IntentHash.t.sol`). The single-field
  fixtures pin field order.
- **Determinism** across runs, processes, and machines is proven by hashing the same fixed
  inputs in separate processes and comparing (`test/determinism.test.ts`).

## Layout

```
src/
  canonicalize.ts   Surface A: RFC 8785 wrapper + hashCanonicalJson
  domain.ts         §9 domain normalizers (address/uint256/money/timestamp/url)
  spendIntent.ts    Surface B: SpendIntent type + hashSpendIntent (§8.1)
  index.ts          public exports
scripts/
  gen-fixture-hashes.ts   fixtures/intents.json -> fixtures/intents.hashes.json (committed)
test/
  rfc8785.vectors.test.ts domain.test.ts spendIntent.test.ts determinism.test.ts
```

## Commands (run from repo root)

```
pnpm test:canon      # RFC vectors + domain rules + determinism + Surface B corpus
pnpm gen:fixtures    # regenerate fixtures/intents.hashes.json (CI asserts no diff)
pnpm typecheck       # tsc --noEmit
```

The shared corpus lives at the repo root `fixtures/` because both TS and Solidity read it.
`intents.hashes.json` is generated and committed; CI regenerates it and fails on any diff, so
the committed hashes are provably an honest function of the fixtures and this code.
