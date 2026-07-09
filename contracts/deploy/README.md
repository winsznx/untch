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
