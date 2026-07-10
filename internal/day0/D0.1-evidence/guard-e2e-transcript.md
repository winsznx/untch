# §14 Mode B — @untch/x402-guard real dogfood e2e

- **When:** 2026-07-10T20:10:28.562Z
- **Buyer:** `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`
- **Seller:** https://untch-asp-production.up.railway.app (live Railway)
- **Policy:** `1` (real stored, allows `logistics`)

## Cycle (all real, no mocks)
1. Buyer authorized $0.01 → the Untch payTo for the ping resource (independent source of truth).
2. `@untch/x402-guard` probed the endpoint, intercepted the **402**, ran the Challenge Binding Check → **BOUND**.
3. Real paid `preflight_payment` ($0.05) → decision **APPROVED** (settled tx `0x86b5d0ced53937b128c6ecfd0fa075ba2e9f1dd49f8d99d5e8c3b1d8aa0ce00d`).
4. APPROVE ⇒ the buyer's OWN signer settled the $0.01 call. The middleware never held the key.

## Settlements (verify by raw RPC — not the service's word)
- **preflight ($0.05):** `0x86b5d0ced53937b128c6ecfd0fa075ba2e9f1dd49f8d99d5e8c3b1d8aa0ce00d` — https://www.oklink.com/x-layer/tx/0x86b5d0ced53937b128c6ecfd0fa075ba2e9f1dd49f8d99d5e8c3b1d8aa0ce00d
- **guarded call ($0.01):** `0xfc45c18a1245494b186eaa9f0b48bb904cbfea3d7aeb2615c3c0e7912ed2485d` — https://www.oklink.com/x-layer/tx/0xfc45c18a1245494b186eaa9f0b48bb904cbfea3d7aeb2615c3c0e7912ed2485d

Structured evidence: `guard-e2e-proof.json`.

## Independent on-chain verification (raw `rpc.xlayer.tech` — not the service's word)

| call | tx | status | block | USDT0 Transfer |
|---|---|---|---|---|
| preflight ($0.05) | `0x86b5d0ced53937b128c6ecfd0fa075ba2e9f1dd49f8d99d5e8c3b1d8aa0ce00d` | `0x1` | 64945190 | 50000 base units (0.05) |
| guarded call ($0.01) | `0xfc45c18a1245494b186eaa9f0b48bb904cbfea3d7aeb2615c3c0e7912ed2485d` | `0x1` | 64945193 | 10000 base units (0.01) |

Both are real settled `USD₮0` (`0x779Ded0…`) transfers on X Layer, `eth_getTransactionReceipt` status
`0x1`. The preflight (block 64945190) settled BEFORE the guarded call (block 64945193) — the exact
middleware sequence: probe → 402 → Challenge Binding Check **BOUND** → real paid preflight **APPROVED**
→ the buyer's OWN signer settled the $0.01 call. The `@untch/x402-guard` middleware never held the key.

Note on the deployed preflight: this ran against the already-deployed `untch-asp-production` seller,
whose live build is the fixture-era preflight (the policy-storage-backed build is committed but its
production redeploy was out of scope for this session). The middleware path and both real settlements
are unaffected by which preflight backing the seller runs — the guard consumes the decision either way.
