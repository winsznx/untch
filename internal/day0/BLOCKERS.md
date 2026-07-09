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

---

# D0.3 BLOCKER — funding gate: no testnet-funded ops wallet

> **SUPERSEDED (2026-07-09):** the funding target below (testnet OKB) was wrong — D0.1 proved
> no testnet facilitator exists, so the whole rail runs on mainnet. The gate now checks
> **mainnet** native OKB. See the mainnet-redirect section at the bottom of this file for the
> current, authoritative D0.3 funding status.

**Gate:** §29 D0.3 · **Result:** constants **PASS**, funding gate **BLOCKED** (no funded testnet ops wallet).
**Date:** 2026-07-09

## What passed (no blocker)
- **X Layer constants verified & shipped** in [`packages/shared/src/chains.ts`](../../packages/shared/src/chains.ts) — mainnet (196) + testnet (**1952**, not the deprecated 195), OKB native, official RPCs, OKLink explorers, faucet. Every value sourced in [`D0.3-sources.md`](./D0.3-sources.md). `tsc --noEmit` clean.
- **§23 Q5 resolved:** USDG on X Layer mainnet = `0x4ae46a509F6b1D9056937BA4500cb143933D2dc8`, **6 decimals** (issuer + explorer + on-chain agree). USDT = `0x1E4a5963aBFD975d8c9021ce480b42188849D41d` (legacy) / USDT0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, both 6 dp.
- **Testnet USDT/USDG left UNCONFIRMED** (`address: null`) — no official testnet address exists; excluded from allowlists, not guessed.
- **`scripts/check-wallet.ts` works** — verified end-to-end against a public funded testnet address (gate PASS/exit 0) and against the empty env (gate FAIL/exit 1). See [`D0.3-evidence/wallet-check.txt`](./D0.3-evidence/wallet-check.txt).

## The one blocker (a step only you can take)
There is **no ops wallet address configured and no testnet OKB balance**. `OPS_WALLET_ADDRESS` in `.env` is empty, so the funding gate cannot pass. Private keys are never handled here — only the public address is needed to prove funding.

**Next action (you):**
1. Choose/generate the ops wallet (custody the private key yourself — never put it in this repo).
2. Set its **public** address in `.env`: `OPS_WALLET_ADDRESS=0x…` (documented in `.env.example`).
3. Fund it with **testnet OKB (gas)** from the official faucet:
   - Faucet: `https://www.okx.com/xlayer/faucet` (also `https://web3.okx.com/xlayer/faucet`)
   - Docs: `https://web3.okx.com/xlayer/docs/developer/bridge/get-testnet-okb-from-faucet`
   - Steps: sign in with an OKX account → select **X Layer Testnet (chainId 1952)** → paste the ops wallet address → complete captcha/eligibility → claim testnet OKB.
4. Re-run `pnpm check-wallet`. PASS = testnet native OKB balance > 0 (exit 0); the run output overwrites `D0.3-evidence/wallet-check.txt` as the funded-wallet evidence.

## Session ended here per instructions (blocked on ops-wallet provisioning + faucet funding — steps only you can do).

---

# D0.1 FUNDING BLOCKER — buyer wallet generated but unfunded

**Gate:** §29 D0.1 · **Result:** BLOCKED (buyer wallet has no settlement token).

A fresh burner buyer wallet was generated. It must be funded before a real x402 call
can settle. No payment was simulated.

- **Fund this address:** `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`
- **Token:** USD₮ `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6 decimals)
- **Amount:** at least 0.01 USD₮ (send ~$0.05 worth for margin)
- **Network:** X Layer Mainnet (eip155:196, chainId 196)
- **Gas:** none needed on the buyer — EIP-3009 is gasless for the signer.

After funding, re-run `pnpm --filter @untch/asp pay`.

---

# D0.1 NETWORK BLOCKER (2026-07-09, 2nd attempt) — OKX facilitator unreachable (HARD, independent of funding)

**Gate:** §29 D0.1 · **Result:** BLOCKED. This blocker is independent of the funding blocker
above — even a fully funded buyer wallet cannot complete a call from this environment.

The scaffold is now built and typechecks clean (`services/asp/`, first-party `@okxweb3/x402-*`
packages). What blocks execution is purely network reachability:

- `OKXFacilitatorClient` (in `@okxweb3/x402-core@0.1.0`) targets `https://web3.okx.com/facilitator`
  for `getSupported` / `verify` / `settle` / `settle/status`.
- From here, `web3.okx.com` and `www.okx.com` time out (HTTP 000) — verified twice, sandbox
  disabled. `rpc.xlayer.tech` and npm ARE reachable; the block is OKX hosts specifically.
- Proven at runtime: the seller cannot even build the 402 challenge offline — an unpaid request
  500s with *"Facilitator does not support exact on eip155:196. Make sure to call initialize()
  to fetch supported kinds from facilitators."* (evidence: `D0.1-evidence/facilitator-dependency-proof.txt`).

**Next action (you):** run `pnpm --filter @untch/asp pay` from a host with outbound access to
`web3.okx.com` (local machine / OKX-whitelisted egress), with a funded `BUYER_PRIVATE_KEY` and a
real `PAY_TO_ADDRESS` set in `services/asp/.env`. The code path (challenge → EIP-3009 sign →
verify/settle → decode PAYMENT-RESPONSE tx hash → write `D0.1-evidence/paid-call-transcript.json`)
is ready and will run unchanged.

## Session ended here per instructions (blocked on OKX network egress + buyer funding — steps only you can do). No payment simulated.

---

# D0.1 RESOLVED — PASS (2026-07-09). Both blockers cleared.

The two D0.1 blockers above (buyer funding + OKX network egress) are **cleared**:
- **Funding:** buyer 0x98F4…c0b funded with USDT0 (1.5) — confirmed on-chain.
- **Egress:** solved by hosting the *seller* on Railway (reachable to web3.okx.com) instead of
  fighting the Nigeria/VPN block locally. Only the seller needs OKX reach.

Real settled paid call executed: tx `0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc` on X Layer mainnet via OKX's hosted x402 facilitator
(relayer 0x5ee567b8… broadcast the EIP-3009 transfer; receipt 0x1). Evidence in `D0.1-evidence/`.
Nothing simulated. **§29 D0.1 = PASS.**

---

# D0.3 — funding target redirected to MAINNET; gate condition fixed; funding RESOLVED

**Gate:** §29 D0.3 · **Result:** gate-condition bug **FIXED**; funding gate **PASS** (mainnet-funded).
**Date:** 2026-07-09
**Note:** the "insufficient (~$0.50)" read below was the *first* attempt this session; after a ~$2
top-up the gate PASSED — see the RESOLVED note at the end of this section.

## What was fixed (code — done, verified)
- `scripts/check-wallet.ts` previously exited nonzero when the **testnet** native OKB balance
  was zero. D0.1 proved no testnet facilitator exists — mainnet is the operative network for
  this entire build — so testnet was the wrong thing to gate on. The gate now checks **mainnet**
  native OKB (chainId 196) against a small sane floor (`MIN_MAINNET_NATIVE_WEI` = 0.0005 OKB).
  Both networks' balances are still printed for visibility; only which one gates PASS/FAIL changed.
- `OPS_WALLET_ADDRESS` set in `.env` (gitignored) to the ops wallet
  `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b` (the same address used as the D0.1 buyer wallet — reused deliberately).
- `pnpm typecheck` clean (exit 0).

## The blocker — live mainnet balance is below the ~$1 provisioning bar
Real on-chain read (no mock), confirmed twice via `rpc.xlayer.tech`:
- **Ops wallet:** `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`
- **Mainnet native OKB:** **`0.006324310650139134` OKB** (`6324310650139134` wei; raw `eth_getBalance` → `0x1677ed51c031fe`; chainId `0xc4` = 196)
- **USD equivalent:** **≈ $0.50** (OKB $79.20, CoinGecko, 2026-07-09) — this balance would need OKB at ~$158 to reach $1.
- Also present on mainnet (not gas): USD₮ (USDT0) **1.5**, from the D0.1 session. USDT/USDG = 0.
- Testnet (1952) native OKB: **0** — no longer gates anything.

Per the session hard rule (*live mainnet native balance under roughly $1 equivalent → STOP,
do not fake a PASS*), **$0.50 is under the ~$1 bar**, so D0.3's funding gate is **not** closed.
The mechanical dust floor (0.0005 OKB) passes, but the operator provisioning bar (~$1) does not.

## RESOLVED — PASS (2026-07-09T08:35Z). Ops wallet funded on mainnet.
The operator topped up the ops wallet with an additional ~$2 of OKB. Live on-chain read
(confirmed twice via `rpc.xlayer.tech`, raw `eth_getBalance` → `0x7000a9129d4bcc`, chainId `0xc4`=196):
- **Ops wallet:** `0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b`
- **Mainnet native OKB:** **`0.031525923553364942`** (`31525923553364940` wei) ≈ **$2.50** (OKB $79.20).
- Above the 0.0005 OKB gate floor **and** the ~$1 provisioning bar. `pnpm check-wallet` → exit 0.
- Evidence: `internal/day0/D0.3-evidence/wallet-check-mainnet.txt` (testnet run kept in `wallet-check.txt`).

**§29 D0.3 funding gate = PASS.** No mock, no simulation. The D0.3 constants were already PASS;
with the ops wallet now funded on mainnet, D0.3 is closed.
