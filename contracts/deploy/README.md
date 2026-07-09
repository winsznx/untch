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
