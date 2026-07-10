# PolicyRegistry — deploy runbook (X Layer **testnet only**)

Driver: [`scripts/deploy-policy-registry.ts`](../../scripts/deploy-policy-registry.ts) (repo root,
run with `tsx` like the other workspace scripts). It computes the demo policy's `policyHash` with
**`@untch/canon`'s `hashCanonicalJson`** — the same canonical-JSON hashing surface the ASP
preflight uses ([`services/asp/src/policy-fixture.ts`](../../services/asp/src/policy-fixture.ts)),
never an ad-hoc scheme — then deploys, registers one demo policy, and reads it back on-chain.

> **Mainnet is deliberately deferred.** Per PRD §22.4 / §28, nothing touches X Layer **mainnet**
> until `IntentRegistry`, `UntchReceipts`, and `UntchVault` also exist and the full contract set
> clears §28's mainnet checklist together. This driver refuses `chainId 196`.

## Status (2026-07-09) — ✅ LIVE ON X LAYER TESTNET

| Item | Value |
|------|-------|
| **Contract** | [`0xe1d74c90801db0fa806c72eb818b7671b8233532`](https://www.oklink.com/x-layer-testnet/address/0xe1d74c90801db0fa806c72eb818b7671b8233532) (chainId 1952) |
| **Source verified** | ✅ OKLink — "Pass - Verified" (repo HEAD source == this deployed bytecode) |
| **Deploy tx** | `0x36df741c9611965fc02e619dea4d6efe91e9641f2e38aae331a4c327eb12f43b` (status `0x1`, block 35156334) |
| **Register tx** | `0xf7f25c7486c8aa4406fe2fb973f75940cbc75991a8e4cf865f1aa4ed83724708` (status `0x1`, emitted `PolicyRegistered`) |
| **Demo policyId** | `43689584780193288224528649685930235207374048247885169918877241264404980193079` |
| **policyHash** | `0x640bdb4c3a438728839abd08b38361df44db3acb60503307214a34b28407384d` — `@untch/canon hashCanonicalJson(demo rules)`, **equals the on-chain value** |
| **Readback** | owner `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`, agent `0x…A9E7`, status ACTIVE, version 1, `isUsable = true` |

Independently re-read from `https://testrpc.xlayer.tech` (raw `eth_getTransactionReceipt` /
`eth_getCode` / `eth_call getPolicy` — not taken on the driver's word). Machine receipt:
[`testnet-receipt.json`](testnet-receipt.json). Local anvil proof of the same path:
[`anvil-proof-receipt.json`](anvil-proof-receipt.json).

## How it was deployed (reproducible)

```bash
# ops wallet 0x98F43e… funded with testnet OKB from https://www.okx.com/xlayer/faucet (chainId 1952)

# deploy + register + readback (DEPLOYER_PRIVATE_KEY = ops key from services/asp/.env; never printed):
RPC_URL=https://testrpc.xlayer.tech DEPLOYER_PRIVATE_KEY=<ops-key> BROADCAST=1 \
  AGENT_ADDRESS=0x000000000000000000000000000000000000A9E7 POLICY_EXPIRY_UNIX=1798761600 \
  pnpm exec tsx scripts/deploy-policy-registry.ts

# verify source on OKLink (no API key needed for the plugin endpoint):
forge verify-contract 0xe1d74c90801db0fa806c72eb818b7671b8233532 src/PolicyRegistry.sol:PolicyRegistry \
  --chain-id 1952 --verifier oklink \
  --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET
```

The driver preflights the balance and refuses to broadcast if funds can't cover gas (prints
GO / NO-GO), and prints a JSON receipt with the address, both tx hashes, the derived `policyId`,
and the `policyHash`.

---

# SpendIntentRegistry — deploy runbook (X Layer **testnet only**)

Driver: [`scripts/deploy-spend-intent-registry.ts`](../../scripts/deploy-spend-intent-registry.ts)
(repo root, run with `tsx`). It builds a §8.1-shaped demo `SpendIntent`, computes its `intentHash`
with **`@untch/canon`'s `hashSpendIntent`** (Surface B — the same off-chain hash the middleware /
receipt path uses), then deploys, **authorizes the deployer as a writer** (exercising the
admin-managed writer set end-to-end), **registers** the demo intent (PENDING), **transitions** it to
APPROVED, and reads it back on-chain — asserting the on-chain `intentHash` equals canon's off-chain
hash. The demo intent references the real PolicyRegistry demo `policyId`/`policyHash` above so the
two contracts tell one coherent story (the reference is stored opaquely — this registry does **not**
validate it against PolicyRegistry, by design).

> **Mainnet is deliberately deferred.** The driver refuses `chainId 196`. Nothing touches X Layer
> **mainnet** until `UntchReceipts` and `UntchVault` also exist and the full contract set clears
> §28's mainnet checklist together.

## Status (2026-07-09) — ✅ LIVE ON X LAYER TESTNET

| Item | Value |
|------|-------|
| **Contract** | [`0xf87e50f83172c2dace7d274e4c701212caeb1372`](https://www.oklink.com/x-layer-testnet/address/0xf87e50f83172c2dace7d274e4c701212caeb1372) (chainId 1952) |
| **Source verified** | ✅ OKLink — "Pass - Verified" (repo HEAD source == this deployed bytecode) |
| **Deploy tx** | `0x568dc43f36f8fe86572ff06d09be26d4f4a8d91e90974d48c341e0a17eae3e90` (status `0x1`, block 35161586) |
| **addWriter tx** | `0x68b7909b1b54f3fe415dc491ee05a60b8771a55b5ac0600d3c473174f8c3063e` (status `0x1`, `isWriter[deployer] = true`) |
| **registerIntent tx** | `0x384a25b463215156e8be5efd478344d0cbda387620c3ca7b744fa5c2b20dadb8` (status `0x1`, emitted `IntentRegistered`) |
| **setStatus tx** | `0x319903425bc6fbc353122ec66459d823c96005a9d5a21c0faf3f17eeb9089a65` (status `0x1`, PENDING → APPROVED) |
| **Demo intentHash** | `0xc55751e84cd9ae642d583e70c868672ccf8c51ca6d93e884dd82373c0c4de09a` — `@untch/canon hashSpendIntent(demo intent)`, **equals the on-chain value** |
| **policyId (ref)** | `43689584780193288224528649685930235207374048247885169918877241264404980193079` (the PolicyRegistry demo policy; not validated on-chain — decision #2) |
| **Readback** | policyId ✓, maxAmount `1000000`, deadline `1786212397`, status **APPROVED**, `isUsable = true`, `isExpired = false`, `admin`/`isWriter[deployer]` = deployer/true |

Independently re-read from `https://testrpc.xlayer.tech` via raw `cast` (`eth_getTransactionReceipt`
on all four txs = `0x1`; `eth_getCode` = 3274 bytes; `eth_call getIntent` / `isUsable` / `isExpired`
/ `admin` / `isWriter`; and `previewIntentHash(struct)` recomputed from independently-hashed fields
== the deployed `intentHash`) — not taken on the driver's word. Machine receipt:
[`spend-intent-testnet-receipt.json`](spend-intent-testnet-receipt.json). Local anvil proof of the
same path: [`anvil-spend-intent-proof.json`](anvil-spend-intent-proof.json).

## How it was deployed (reproducible)

```bash
# ops wallet 0x98F43e… funded with testnet OKB (chainId 1952). DEPLOYER_PRIVATE_KEY = ops key from
# services/asp/.env (BUYER_PRIVATE_KEY on this wallet); never printed.
RPC_URL=https://testrpc.xlayer.tech DEPLOYER_PRIVATE_KEY=<ops-key> BROADCAST=1 \
  pnpm exec tsx scripts/deploy-spend-intent-registry.ts

# verify source on OKLink (no API key needed for the plugin endpoint):
forge verify-contract 0xf87e50f83172c2dace7d274e4c701212caeb1372 src/SpendIntentRegistry.sol:SpendIntentRegistry \
  --chain-id 1952 --verifier oklink \
  --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET
```

---

# UntchReceipts — deploy runbook (X Layer **testnet only**)

Driver: [`scripts/deploy-untch-receipts.ts`](../../scripts/deploy-untch-receipts.ts) (repo root, run
with `tsx`). It deploys `UntchReceipts(delay)`, then authorizes the deployer as a writer **through
the admin timelock end-to-end** (propose → prove execute reverts before the delay via a read-only
`eth_call` → wait the real delay → execute), logs a demo batch of 3 §10.3 receipts in one tx, anchors
one score root and one audit report, reads it all back, and finally **measures real gas** by sending
`logReceipts` batches of 1 / 10 / 50 and recording `gasUsed` from the real receipts. It references the
real SpendIntentRegistry demo intent/policy so the three contracts tell one coherent story.

> **Mainnet is deliberately deferred.** The driver refuses `chainId 196`. Nothing touches X Layer
> **mainnet** until `UntchVault` also exists and the full contract set clears §28's mainnet checklist
> together.

## Status (2026-07-09) — ✅ LIVE ON X LAYER TESTNET

| Item | Value |
|------|-------|
| **Contract** | [`0x0c64997277b7d94d2999dea22a123cac56334863`](https://www.oklink.com/x-layer-testnet/address/0x0c64997277b7d94d2999dea22a123cac56334863) (chainId 1952) |
| **Source verified** | ✅ OKLink — "Pass - Verified" |
| **Timelock delay** | 60s (testnet demo value; a mainnet deploy would use e.g. 48h) |
| **Deploy tx** | `0xf0df27f3970daffa63bd32f61033c6737bafb30278b72aeb637d5120126d43f1` (status `0x1`, block 35174695) |
| **propose tx** | `0x15dbc176672efb5d5f33b67671e54462061b28e008251db6575cbb0c1b58ed81` (opId `0xda9d…70ae`, eta 1783633596) |
| **execute-before-delay** | reverts (read-only `eth_call`) — the §10.3 timelock property, on-chain |
| **execute tx** | `0x7ec1447966c081f74115da8c6fbc6caacf467e1baadf71eee593f9df3a727162` (after the 60s delay; `isWriter[deployer]=true`) |
| **logReceipts tx (batch of 3)** | `0x09a4297b1be05b364468e3723f5679a86c60e8f40b00025e73e4ee3c64f7ab3a` (ReceiptLogged×3 + BatchLogged id 1) |
| **anchorScore tx** | `0xba85dbf61d6c5ac4fef61501c20480c71e5af37e377d707bc31c53d90743cb88` |
| **anchorAudit tx** | `0xa1ba739455c0f6999df3a42f662f59191a833688b8e2cbc0524f29542288b8d6` |
| **Readback** | batchCount=4, timelockDelay=60, SCHEMA_VERSION=1, admin=deployer, isWriter[deployer]=true, opEta=0 |

**Independently re-read** from `https://testrpc.xlayer.tech` via raw `eth_getTransactionReceipt`
(`cast receipt --json`) per tx — all 9 tx status `0x1`; event topics counted + fields decoded
client-side (**64 ReceiptLogged, 4 BatchLogged, 1 ScoreAnchored, 1 AuditAnchored, 1 OpProposed, 1
OpExecuted, 1 WriterAdded**); the demo `ReceiptLogged` decodes to `schemaVersion=1` and `agentId =
0x00…01` (= `bytes32(uint256 buyerAgentId=1)`, a numeric id, **not** an address — judgment call 1) —
not taken on the driver's stdout. Machine receipt:
[`untch-receipts-testnet-receipt.json`](untch-receipts-testnet-receipt.json). Local anvil proof of the
same path: [`anvil-untch-receipts-proof.json`](anvil-untch-receipts-proof.json).

## Measured gas/receipt (real testnet txs — §17/§25/§10.4 "no cost claim before measurement")

| Batch size | Total gasUsed | Gas / receipt |
|-----------:|--------------:|--------------:|
| 1 | 42,109 | 42,109 |
| 10 | 149,270 | 14,927 |
| 50 | 658,610 | 13,172 |

**Marginal gas/receipt (50 vs 10): ≈ 12,734.** Batching amortizes the fixed per-tx overhead (~21k
intrinsic + the batch-counter `SSTORE` + the `BatchLogged` event) across the batch — from ~42k/receipt
at size 1 down to ~13k/receipt at size 50. This is the first **measured** number behind §10.4's
events-only, batched anchoring; no cost was claimed before it.

## How it was deployed (reproducible)

```bash
# ops wallet 0x98F43e… funded with testnet OKB (chainId 1952). DEPLOYER_PRIVATE_KEY = ops key from
# services/asp/.env (BUYER_PRIVATE_KEY on this wallet); never printed.
RPC_URL=https://testrpc.xlayer.tech DEPLOYER_PRIVATE_KEY=<ops-key> TIMELOCK_DELAY=60 BROADCAST=1 \
  pnpm exec tsx scripts/deploy-untch-receipts.ts

# verify source on OKLink (constructor takes uint64 delay = 60):
forge verify-contract 0x0c64997277b7d94d2999dea22a123cac56334863 src/UntchReceipts.sol:UntchReceipts \
  --chain 1952 --constructor-args $(cast abi-encode "constructor(uint64)" 60) \
  --verifier oklink \
  --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET
```

---

# UntchVault — deploy runbook (X Layer **testnet only**)

Driver: [`scripts/deploy-untch-vault.ts`](../../scripts/deploy-untch-vault.ts) (repo root, run with
`tsx`). It deploys the vault (§10.4) with a **plain constructor** — no factory / CREATE2 (that is the
next, separate prompt) — binds it to the **real, already-deployed §10.2 `SpendIntentRegistry`**
(`0xf87e…1372`) with `requireAnchoredIntent = true`, deposits real tokens, executes a real
**oracle-signed `spend`** that references the registry's **real APPROVED demo intent** (so the vault's
cross-contract `isUsable` check actually runs against live §10.2 state on-chain), a real
**`spendFallback`**, a deliberately-**invalid over-cap spend** (confirmed reverted via read-only
`eth_call`), and a real **`ownerWithdraw`**; then reads everything back and **measures real gas** for
both spend paths.

> **Settlement token.** [`packages/shared/chains.ts`](../../packages/shared/src/chains.ts) has **no
> confirmed X Layer *testnet* USDT0 address** (only mainnet USDT0 is confirmed; the testnet faucet
> issues native OKB only). So the demo deploys a standard-compliant test ERC20 (the same `MockERC20`
> the unit suite uses) as the settlement token — a real, transferable token to exercise
> deposit/spend/withdraw on-chain. The vault uses **SafeERC20** precisely so the identical code also
> handles the eventual (possibly non-standard) mainnet token; the demo just needs *a* real ERC20.

> **Mainnet is deliberately deferred.** The driver refuses `chainId 196`. Nothing touches X Layer
> **mainnet** until the full contract set (incl. the vault factory) clears §28's mainnet checklist
> together (§22.4). The `UntchVaultFactory` / CREATE2 is the **next, separate prompt**.

## Status (2026-07-10) — ✅ LIVE ON X LAYER TESTNET

| Item | Value |
|------|-------|
| **Vault** | [`0x42e699ffd8215d48397a049b4f7a176db06f4848`](https://www.oklink.com/x-layer-testnet/address/0x42e699ffd8215d48397a049b4f7a176db06f4848) (chainId 1952) |
| **Source verified** | ✅ OKLink — "Pass - Verified" (`forge verify-check` → `Pass - Verified`) |
| **Demo token (MockERC20)** | `0xf202ce41d76ee1a2aec72e7a9180331d437ddd41` (6-dec standard ERC20; testnet demo token — see note above) |
| **Owner** | `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b` (fund sovereign, §16 I4) |
| **Oracle (demo)** | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (throwaway demo key, distinct from owner) |
| **IntentRegistry (real §10.2)** | `0xf87e50f83172c2dace7d274e4c701212caeb1372`, `requireAnchoredIntent = true` |
| **Anchored intent** | `0xc557…de09a` — the real APPROVED demo intent; `isUsable = true` re-checked on-chain by the vault |
| **Caps** | perTxCap `100e6`, epochBudget `250e6`, epochLen `86400s` |
| **Vault deploy tx** | `0x32de3cf48537e28e0e503866951fe59b1ce9d89d2e8f8d0758a1c1b2acc06b68` (status `0x1`, block 35195314) |
| **deposit tx** | `0x4b3e414cbfb7848bc3d03932355e0c28f44dfad2bff113a53621bb6003ca987a` (500e6) |
| **spend tx (oracle path, anchored)** | `0x78df082ef84fe80705368c741e6b32b15bf09b116dd93dbf92e4cacfd1251d70` (40e6 → payee; `gasUsed 123,751`) |
| **spendFallback tx** | `0x60627036b65f6bbc099db06e97a7cda9b66eff2157b2bd2713b9c32ff439d4db` (10e6 → fallbackee; `gasUsed 76,036`) |
| **invalid over-cap spend** | reverts (read-only `eth_call`) — `CapExceeded`, the §7.5 cap enforced on-chain |
| **ownerWithdraw tx** | `0x28008dee041abb7e994d6b4a716227ed3cd236bba354c721a60d61f61575c94b` (100e6 → owner, unconditional) |
| **two-step ownership (raw cast)** | `transferOwnership(deployer)` → `pendingOwner` = deployer → `acceptOwnership()` → `owner` = deployer, `pendingOwner` = 0 (judgment call 4 owner-rotation, proven on-chain) |
| **Readback** | owner ✓, oracle ✓, perTxCap 100e6, epochBudget 250e6, **epochSpent 50e6** (40 spend + 10 fallback), requireAnchoredIntent true, tokenAllowed true, paused false; balances **payee 40e6 / fallbackee 10e6 / vault 350e6** (500 − 40 − 10 − 100) |

**Independently re-read** from `https://testrpc.xlayer.tech` via raw `cast` (`owner`/`oracle`/
`perTxCap`/`epochBudget`/`epochSpent`/`requireAnchoredIntent`/`tokenAllowed`/`paused`, the three token
balances, the real registry's `isUsable`, and all five tx statuses = `0x1`) — not taken on the driver's
own word. Machine receipt: [`untch-vault-testnet-receipt.json`](untch-vault-testnet-receipt.json).

## Measured gas (real X Layer testnet txs — §7/§28 gas stage)

| Operation | gasUsed |
|-----------|--------:|
| `spend` (oracle path: EIP-712 recover + cross-contract `isUsable` + SafeERC20 transfer) | **123,751** |
| `spendFallback` (owner path: allowlist + epoch + SafeERC20 transfer) | **76,036** |

The oracle path costs ~50k more than the fallback path — the difference is the ECDSA recovery and the
external `isUsable` call to the real registry, both of which the fallback path substitutes with a
single owner-preapproved allowlist read.

## How it was deployed (reproducible)

```bash
# ops wallet 0x98F43e… funded with testnet OKB (chainId 1952). DEPLOYER_PRIVATE_KEY = ops key from
# services/asp/.env (BUYER_PRIVATE_KEY on this wallet); never printed. ORACLE_PRIVATE_KEY defaults to a
# throwaway demo key; INTENT_REGISTRY/DEMO_INTENT_HASH default to the live §10.2 registry + its intent.
RPC_URL=https://testrpc.xlayer.tech DEPLOYER_PRIVATE_KEY=<ops-key> BROADCAST=1 \
  pnpm exec tsx scripts/deploy-untch-vault.ts

# verify source on OKLink (constructor is the full 8-arg tuple):
forge verify-contract 0x42e699ffd8215d48397a049b4f7a176db06f4848 src/UntchVault.sol:UntchVault \
  --chain 1952 \
  --constructor-args $(cast abi-encode "constructor(address,address,address,uint256,uint256,uint64,address[],bool)" \
    0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
    0xf87e50f83172c2dace7d274e4c701212caeb1372 100000000 250000000 86400 \
    "[0xf202ce41d76ee1a2aec72e7a9180331d437ddd41]" true) \
  --verifier oklink \
  --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET
```


---

# UntchVaultFactory — deploy runbook (X Layer **testnet only**)

PRD §10.4 — the CREATE2 factory that deploys `UntchVault` at addresses deterministic per
`(owner, agent)`. Holds no funds; only deploys vaults. This is the **fifth and final** §10 contract.

> **Mainnet is deferred (§22.4).** The full five-contract set clears §28's mainnet checklist
> **together**; nothing here touches X Layer mainnet.

## Status (2026-07-10) — ✅ LIVE ON X LAYER TESTNET

- **Factory:** [`0x1562c6eb1813016c8562cf6771cbf715007bb7e9`](https://www.oklink.com/x-layer-testnet/address/0x1562c6eb1813016c8562cf6771cbf715007bb7e9)
  — source **verified** on OKLink ("Pass - Verified"). Deploy tx `0x2a8a…e666` (block 35213461).
- **Canonical `intentRegistry` (immutable, decision B):** `0xf87e50f83172c2dace7d274e4c701212caeb1372`
  (the live §10.2 registry) — read back on-chain from the factory.
- **Real predict → deploy → readback demo** (`deploy/untch-vault-factory-testnet-receipt.json`):
  - `computeVaultAddress(owner, agent, …)` predicted `0x84BA33d61d47881876f9AD5Ed88ed3e129c78975`
    (0 code before deploy).
  - `deployVault(…)` (tx `0xdcb75034…f1beccf9`, block 35213533, **gasUsed 1,161,751**) landed the vault
    at **exactly** that address (0 → 4940 bytes) — prediction matched.
  - The deployed vault's immutables, read back independently via raw `cast` (not the driver's report):
    `owner` = the deployer/caller, `oracle` = `0x7099…79C8`, `intentRegistry` = the factory's canonical
    `0xF87E…1372`, `perTxCap` 100000000, `epochBudget` 250000000, `epochLen` 86400,
    `requireAnchoredIntent` true, `tokenAllowed(token)` true — **every value matches what was passed in**.
  - Guards proven on-chain via `eth_call`: a second `deployVault(owner, agent, …)` reverts
    **`VaultAlreadyDeployed`** (`0x9771b235`); `deployVault` with `owner != caller` reverts
    **`OwnerMustBeSender`** (`0xa33c0f06`).

## How it was deployed (reproducible)

```bash
# ops wallet 0x98F43e… funded with testnet OKB (chainId 1952). DEPLOYER_PRIVATE_KEY = ops key from
# services/asp/.env (BUYER_PRIVATE_KEY on this wallet); never printed. INTENT_REGISTRY/DEMO_AGENT/
# DEMO_TOKEN default to the live §10.2 registry + fixed demo salt seed + the live demo ERC20.
RPC_URL=https://testrpc.xlayer.tech DEPLOYER_PRIVATE_KEY=<ops-key> BROADCAST=1 \
  pnpm exec tsx scripts/deploy-untch-vault-factory.ts

# verify source on OKLink (constructor is the single canonical intentRegistry address):
forge verify-contract 0x1562c6eb1813016c8562cf6771cbf715007bb7e9 src/UntchVaultFactory.sol:UntchVaultFactory \
  --chain 1952 \
  --constructor-args $(cast abi-encode "constructor(address)" 0xf87e50f83172c2dace7d274e4c701212caeb1372) \
  --verifier oklink \
  --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET
```
