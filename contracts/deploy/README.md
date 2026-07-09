# PolicyRegistry — deploy runbook (X Layer **testnet only**)

Driver: [`scripts/deploy-policy-registry.ts`](../../scripts/deploy-policy-registry.ts) (repo root,
run with `tsx` like the other workspace scripts). It computes the demo policy's `policyHash` with
**`@untch/canon`'s `hashCanonicalJson`** — the same canonical-JSON hashing surface the ASP
preflight uses ([`services/asp/src/policy-fixture.ts`](../../services/asp/src/policy-fixture.ts)),
never an ad-hoc scheme — then deploys, registers one demo policy, and reads it back on-chain.

> **Mainnet is deliberately deferred.** Per PRD §22.4 / §28, nothing touches X Layer **mainnet**
> until `IntentRegistry`, `UntchReceipts`, and `UntchVault` also exist and the full contract set
> clears §28's mainnet checklist together. This driver refuses `chainId 196`.

## Status (2026-07-09)

| Gate | Result |
|------|--------|
| Local end-to-end proof (anvil, chainId 31337) | ✅ **PASS** — deploy → register → readback round-trips; on-chain `policyHash` equals the canon hash. See [`anvil-proof-receipt.json`](anvil-proof-receipt.json). |
| X Layer testnet RPC reachable (chainId 1952) | ✅ `https://testrpc.xlayer.tech` answers `eth_chainId → 0x7a0`. |
| Deploy gas estimate against testnet | ✅ ~729,598 gas (deploy) via the driver's preflight. |
| Ops-wallet gas (`0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`) | ❌ **0 OKB on testnet.** deploy+register needs ~`1.7254e-5` OKB (≈17.25 µOKB) at 0.02 gwei. |
| Official faucet (`https://www.okx.com/xlayer/faucet`, chainId 1952) | ❌ **HTTP 000 — unreachable from this environment.** Same OKX-domain network block recorded in D0.1 / D0.3 / D0.4 (`web3.okx.com` / `www.okx.com` return 000 here). |
| **Live testnet deploy + explorer verify + real registered policy** | ⛔ **BLOCKED — on testnet gas only.** Not faked. |

**Why blocked, precisely:** the code, the canon hashing, the RPC path, and the register/readback
logic are all proven (anvil). The single missing input is a faucet drip of testnet OKB, and the
only official X Layer faucet lives on an OKX domain that is network-unreachable from this build
environment. Third-party faucets require interactive wallet/social auth and cannot be scripted.
This is an environmental funding gap, not a contract or tooling defect.

## One-command finish once the ops wallet holds testnet OKB

```bash
# 1) fund 0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b with a little testnet OKB
#    (https://www.okx.com/xlayer/faucet, chainId 1952) from a browser that can reach OKX.

# 2) deploy + register + readback (DEPLOYER_PRIVATE_KEY = ops wallet key, from services/asp/.env):
RPC_URL=https://testrpc.xlayer.tech \
  DEPLOYER_PRIVATE_KEY=<ops-wallet-key> \
  BROADCAST=1 \
  pnpm exec tsx scripts/deploy-policy-registry.ts

# 3) verify source on the X Layer testnet explorer (command is printed in the driver's receipt):
forge verify-contract <deployedAddress> src/PolicyRegistry.sol:PolicyRegistry \
  --chain 1952 --verifier oklink \
  --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET
```

The driver preflights the balance and refuses to broadcast if funds can't cover gas, so step 2 is
safe to run before funding (it prints GO / NO-GO). It also prints a JSON receipt with the deployed
address, both tx hashes, the derived `policyId`, and the `policyHash` for the record.
