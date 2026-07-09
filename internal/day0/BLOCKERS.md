# D0.1 BLOCKERS — paid A2MCP hello-world could not be completed in this environment

**Gate:** §29 D0.1 · **Result:** **FAIL / BLOCKED** (no real settled paid call executed).
**Date:** 2026-07-09
**No mock, demo, or substitute-rail call was made** (per instructions). Evidence of the blockers is in [`D0.1-evidence/`](./D0.1-evidence/). Full doc findings are in [`D0.1-payment-sdk-notes.md`](./D0.1-payment-sdk-notes.md).

The task cannot proceed without the following. Each is a step only you can take.

---

## Blocker 1 — OKX API / docs / facilitator hosts are network-unreachable from this environment (HARD)
- `https://www.okx.com/*` and `https://web3.okx.com/*` return HTTP `000` (no connection) — **verified even with the sandbox disabled**. `okx.ai` and npm are reachable; the OKX API/docs/facilitator hosts specifically are not.
- The OKX x402 **facilitator** (verify/settle) and the official **integration docs** both live on those hosts, so: (a) I cannot read the authoritative Payment SDK integration page, and (b) a real settlement cannot originate here.
- **Next action (you):** run this task from an environment with outbound network access to `okx.com` and `web3.okx.com` (local machine / a box on your normal network / OKX-whitelisted egress). **OR** paste the two key doc pages so I can at least finalize the integration design:
  - `https://web3.okx.com/onchainos/dev-docs/payments/x402-introduction`
  - the x402 **seller quickstart** + **facilitator endpoint** page(s) under `web3.okx.com/onchainos/dev-docs/payments/…`

## Blocker 2 — settlement auth model + funding are unconfirmed / not provisioned (HARD)
- `.env` currently holds only the OKX **REST API HMAC triple** (`OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`). It has **no on-chain EVM private key** and there is **no confirmed funded X Layer (chainId 196) USDT/USDG balance**.
- It is **unverified** whether OKX x402 settles (A) self-custody — you sign EIP-3009 with an EVM private key and USDT leaves *your* X Layer wallet — or (B) custodially — the Payment API charges your **OKX account balance** via the API key. The SKILL.md's "local-key sign" wording implies (A) is supported; (B) is unconfirmed. This determines exactly what you must provide.
- **Next action (you) — answer one of:**
  - If **(A) self-custody:** add `XLAYER_SETTLEMENT_PRIVATE_KEY=` to `.env` (a burner EVM key) and fund it with a small amount of **USDT (or USDG) on X Layer**. Confirm the token to use.
  - If **(B) custodial:** confirm the OKX account behind the API key is **funded with USDT/USDG** and that the Payment API charges that balance (point me at the doc that says so).
  - **Testnet preference:** confirm whether an **X Layer testnet x402 facilitator + faucet** exists so we can do a low/zero-value real settlement first. If yes, share the facilitator URL + faucet; if no, confirm you accept a smallest-amount **mainnet** call.

## Blocker 3 — ASP *listing* requires OKX internal review (SOFT for the hello-world, HARD for §11 "marketplace revenue")
- Being a **listed A2MCP ASP** (§19: "must pass OKX internal review and go live") is a human approval gate only you can clear. Raw x402 pay-per-call is documented as "no registration," so the **D0.1 hello-world call itself may not need the listing** — but any claim of "visible marketplace revenue / sold-count / reviews" (§11, §17) does.
- **Next action (you):** decide whether D0.1 proves the point via a **raw x402 self-hosted priced endpoint** (no listing needed — I can build `ping_untch` and call it once funds/facilitator are available) or must go through a **listed marketplace tool** (then start the ASP review now; that's D0.2).

---

## What is ready to go the moment Blockers 1 & 2 clear
- Notes + verified protocol facts (schemes, headers, chainId 196, `PAYMENT-RESPONSE` settlement record) — see notes file.
- `.env.example` + `.gitignore` in place (secrets never committed).
- Plan for `services/asp/`: an `x402-express` (v1.2.0) seller exposing **one** tool `ping_untch({echo}) → {echo, ts}` priced at the minimum, returning the 402 challenge (asset=USDT/USDG, network=196, `payTo`, `maxAmountRequired`, `resource`); buyer pays via the OKX facilitator; capture request/response JSON + decoded `PAYMENT-RESPONSE` (tx hash) + console transcript into `D0.1-evidence/`.

## Session ended here per instructions (blocked on account/funding/network steps only you can do).
