# Step-2 — preflight_payment end-to-end proof (continuation of D0.1)

- **When:** 2026-07-09T11:38:07.908Z
- **Buyer / owner:** `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b` (funded burner from D0.1)
- **Seller:** https://untch-asp-production.up.railway.app (Railway; reaches the OKX facilitator)
- **Price paid:** $0.05 USD₮0 on eip155:196 (real x402/EIP-3009)

## Cycle
1. `POST /create_spend_intent` → 200, intentHash `0x7a140719ed248509828960f7811d01612edcf15eba75e30705440a70c8334811` (onchain: null — no registry yet).
2. `POST /preflight_payment` unpaid → **402** PAYMENT-REQUIRED (challenge captured).
3. Buyer signed EIP-3009 `transferWithAuthorization`; PAYMENT-SIGNATURE sent (captured).
4. OKX facilitator settled on X Layer → PAYMENT-RESPONSE tx `0x2e6dcfe8e1250deeb85a790b72e3ac1ebcd96031041cada7db028506bb0b8c46`.
5. Seller ran the REAL @untch/policy-engine → decision **APPROVED**.

## Result: PASS
- Settlement success: true
- Settlement tx: `0x2e6dcfe8e1250deeb85a790b72e3ac1ebcd96031041cada7db028506bb0b8c46` — https://www.oklink.com/x-layer/tx/0x2e6dcfe8e1250deeb85a790b72e3ac1ebcd96031041cada7db028506bb0b8c46
- Policy decision returned: **APPROVED**
- receiptRef / sig in the decision: **null** (receipt writer + oracle signer not built yet).

Full structured evidence: `step2-preflight-proof.json`.
