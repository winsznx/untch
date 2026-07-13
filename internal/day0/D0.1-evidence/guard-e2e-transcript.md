# §14 Mode B — @untch/x402-guard real dogfood e2e

- **When:** 2026-07-10T20:38:57.526Z
- **Buyer:** `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`
- **Seller:** https://untch-asp-production.up.railway.app (live Railway)
- **Policy:** `60857684564038047174277665130531299196547049270835523655077624958943947360678` (real stored, allows `logistics`)

## Cycle (all real, no mocks)
1. Buyer authorized $0.01 → the Untch payTo for the ping resource (independent source of truth).
2. `@untch/x402-guard` probed the endpoint, intercepted the **402**, ran the Challenge Binding Check → **BOUND**.
3. Real paid `preflight_payment` ($0.05) → decision **APPROVED** (settled tx `0x2a263b40339d1313c6cb1c069355f3ca5b3dd4fa3e9357b77a6ed3c49d87efe9`).
4. APPROVE ⇒ the buyer's OWN signer settled the $0.01 call. The middleware never held the key.

## Settlements (verify by raw RPC — not the service's word)
- **preflight ($0.05):** `0x2a263b40339d1313c6cb1c069355f3ca5b3dd4fa3e9357b77a6ed3c49d87efe9` — https://www.oklink.com/x-layer/tx/0x2a263b40339d1313c6cb1c069355f3ca5b3dd4fa3e9357b77a6ed3c49d87efe9
- **guarded call ($0.01):** `0x8c43a2e3dafa8ab3c806099063cf83e9c2bbcc01b579138ae6df2e7d6d761412` — https://www.oklink.com/x-layer/tx/0x8c43a2e3dafa8ab3c806099063cf83e9c2bbcc01b579138ae6df2e7d6d761412

Structured evidence: `guard-e2e-proof.json`.

## Post-redeploy live proof (fresh — nothing re-cited from before the redeploy)

The `untch-asp-production` seller was redeployed to current (policy-storage-backed preflight, commit
`640a834`, incl. §6.2 policy CRUD + `@untch/x402-guard`). `OPERATOR_PRIVATE_KEY` (the interim demo
wallet `0x98F43e…`) was configured so the write path is live. Then, entirely through the live URL:

1. **Created a fresh policy via `POST /create_spend_policy`** (category `compute`):
   - policyId `60857684564038047174277665130531299196547049270835523655077624958943947360678`
   - policyHash `0x2bff1b1dfdf6067eb34062622e547fc0881c1a65bc37955c88b0121353222035`
   - on-chain `registerPolicy` tx `0x6a70b3063c5bce091408940692cecf84764428c8dff343d642fc5f3acde00c6c`
     — X Layer **testnet**, block 35257075, status `0x1`, to PolicyRegistry `0xe1d74c90…`.
     `PolicyRegistered` event indexed `policyId` decodes to the exact id above; `policyHash` in event data. ✓
2. **Real preflight live** against that fresh policy → **APPROVED** (settled `$0.05`):
   tx `0x2a263b40339d1313c6cb1c069355f3ca5b3dd4fa3e9357b77a6ed3c49d87efe9` — mainnet block 64946900,
   status `0x1`, USDT0 Transfer 50000.
3. **Guard-mediated payment live** ⇒ the buyer's own signer settled `$0.01`:
   tx `0x8c43a2e3dafa8ab3c806099063cf83e9c2bbcc01b579138ae6df2e7d6d761412` — mainnet block 64946902,
   status `0x1`, USDT0 Transfer 10000.

Non-coincidence: `compute` is in NO fixture allow-list and not in the pre-existing `logistics` policy —
the APPROVE could only come from the freshly-created stored policy the redeployed build read. All three
txs independently verified by raw `testrpc.xlayer.tech` / `rpc.xlayer.tech`, not the service's report.
