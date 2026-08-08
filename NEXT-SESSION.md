# Next session: run the paid calls

Everything that can be verified without spending money has been. What is left needs
a wallet, which is why it is a separate session.

Paste the block under **Prompt** into a new Claude session, from `/Users/mac/untch-v3`.

---

## Where things stand

Live: `https://asp.untch.xyz`, Cloudflare Worker, branch `feat/production-cutover` (PR #107).
Nothing runs on Railway. Postgres is Supabase, reached through Hyperdrive.

`/readyz` should report `attested: true`, `financiallyArmed: true`, `armingRefusals: []`.
**If it does not, stop and read the deploy section below — nothing will settle.**

Verified without spending:

- All 28 registry routes answer, and every refusal names its reason. No unexplained 503s.
- All 6 paid services challenge at the listed price to the listed payee, on **both**
  discovery paths OKX uses: direct URL and MCP JSON-RPC.
- 43/43 live acceptance checks, 777 tests, both typechecks.
- The account chain works end to end up to the signature:
  `link/start` → real SIWE message → `link/complete` refuses a bad signature with 401
  (which proves EIP-1271 verification reaches X Layer from the Worker).
- The browser journey exists as of 2026-08-07. `link/start` had always advertised
  `walletActionUrl: {base}/link/{id}` and told users to open it; nothing served that page
  on any transport, so step one of account setup was a 404 and everything behind it was
  reachable only by driving the raw API by hand. There is now a real self-contained signing
  page there, plus `POST /consumer/account/link/:id/message` so the server authors the SIWE
  message once a wallet reveals its address. The one-time code rides in the URL fragment,
  which browsers never send to a server.

  **Still unproven: a GOOD signature.** We have only ever shown a bad one is refused.
  Closing that costs nothing.

- **Use the AGENTIC path, not the browser one.** `/consumer/account/link/*` assumes an
  injected EIP-1193 provider, which reaches the OKX browser EXTENSION — a different wallet
  product with different keys from the Onchain OS wallet you restore with email. Linking
  the extension would bind a wallet holding none of your funds. All four agentic routes are
  live as of 2026-08-07 and walked end to end (bad signature correctly refused at step 4):

      POST /consumer/account/agentic-link/start
      GET  /consumer/account/agentic-link/{id}/challenge?address=0x…
      POST /consumer/account/agentic-link/{id}/complete   {address, message, signature}
      GET  /consumer/account/agentic-link/{id}/status     -> WAITING_FOR_SIGNATURE

  The challenge returns the message under `message` (not `siweMessage`), plus
  `expectedAddress`, `nonce`, `signWith`, `creates` and `doesNotAuthorize`. Your `onchainos`
  session signs it inside the TEE and posts it back; the browser polls `status`.

**Settlement is proven.** Two real paid calls went through on 2026-08-07, one by direct
URL and one through MCP:

- `suggest_names` 0.01 USDT — `0xf02189d0811f2c0fcf8baaa93410a7b2df7c5436e92fb4018620c741b920e247`
- `suggest_names` 0.01 USDT via `/mcp` — `0xb8e4dd0b5b7c3ec56276a1e240f2c78389ddb8e27c1ec0f55f30563ff66fb91d`

Both returned valid results. That run also found two real bugs, both now fixed and
deployed but **neither yet confirmed against a live payment**:

1. The sale was never recorded. The arming wrapper took three parameters and forwarded
   three, silently dropping the recorder passed as the fourth. Both settlements left
   `untch_marketplace_sales` empty.
2. A registered policy was invisible to its own account. `policy_sync` stored the policy
   and never linked it, so `GET /consumer/policies` was empty and setting the default
   answered POLICY_NOT_FOUND — for a policy confirmed on chain.

### What is already proven about the facilitator

Research raised two worries about OKX's hosted facilitator. Both were checked before the
paid calls ran, and the settlements above have since confirmed the conclusion from the
other direction. Kept because it explains WHY a client-side failure can look like a
server-side one.

*The base URL is right.* The concern was that `@okxweb3/x402-core` hardcodes
`https://web3.okx.com/facilitator`, a path that 404s — the canonical one has no
`/facilitator` prefix. That string does exist in the package, but it is not what we use:
`OKXFacilitatorClient` defaults to `baseUrl: "https://web3.okx.com"`, and nothing here
passes `facilitatorUrl`, so the default stands. Our calls go to
`https://web3.okx.com/api/v6/pay/x402/*`, which is the canonical path.

*OKX is reachable from Cloudflare, and our keys authenticate.* This is not inference from
config — every 402 we serve proves it. On the first priced request the resource server
calls `initialize()`, which fetches supported kinds from the facilitator. It warns per
facilitator on failure but then **throws** if no facilitator supplied any kinds, and our
adapter turns that into a 502. Three live priced requests returned 402, with zero
`Failed to fetch supported kinds` warnings and zero 5xx in `wrangler tail`. So the
authenticated HMAC round trip to OKX succeeded from Cloudflare's egress.

That matters because OKX hosts are unreachable from Nigerian residential/VPN egress
(TCP SYN dropped, HTTP 000). Cloudflare's egress is not affected. **Run the paid call
from a network that can reach `web3.okx.com`, or expect the client side to fail even
though the server side is fine.**

## All nine relisting services are proven end to end (2026-08-08)

Every one bought with real money from the Onchain OS wallet, or verified returning real output.

| service | proof |
|---|---|
| suggest_names $0.01 | settled, direct URL and MCP |
| detect_duplicate $0.02 | settled via MCP, real result |
| redact_payment_metadata $0.02 | settled, email redacted + hash |
| brand_pack $0.05 | settled, 7.5KB LLM output |
| preflight_payment $0.05 | **APPROVED_AUTOMATIC**, rule trace, budget reservation `rsv_30908f07…` |
| verify_delivery $0.10 | **VERIFY_FAILED / WITHHOLD**, T0 diff naming the missing acceptance criteria |
| rank_options, check_domains, seo_tips | free, real output |

Spend: 0.52 → 0.28 USD₮0, $0.24 total. Every failing call settled nothing, confirming the
failing-handler guard in production.

The full account lifecycle also ran for the first time: agentic-link (TEE signature) → session
→ policy_draft → registerPolicy on X Layer → policy_sync → default policy set. Two policies
registered: `2120285619…572` and `19094645725…019`.

Gotchas that cost a probe each, worth knowing before the next run:

- `currency` must be exactly `USD₮0` — U+0055 U+0053 U+0044 U+20AE U+0030, the trailing 0 included.
  It is the token's real on-chain symbol and what the OKX wallet shows. `USDT`, `USDT0` (ASCII T)
  and the old truncated `USD₮` (no 0) are all refused CURRENCY_NOT_SETTLEABLE.
- Marketplace `verify_delivery` takes `intentHash`, not `intentId`. Sending `intentId` alone
  routes to the account-scoped public verify, which needs a session bearer the CLI cannot attach.
- A public `preflight_payment` needs `Authorization: Bearer <session>`. The CLI's two-phase
  `pay` cannot send it, so use `payment pay --payload` sign-only mode and replay with curl.
- `payment quote <direct-url>` then `pay` replays with GET and hits the paid probe's 405. Use
  `--tool` over `/mcp`, which is the path the marketplace client takes anyway.

## What must be proven now

Two things, both cheap.

**One row in `untch_marketplace_sales`.** The recorder now reaches the settlement layer,
but that has only been proven in tests. One `suggest_names` call at $0.01 settles it.
If the payment succeeds and the table is still empty, `recordSale` itself is the
problem: it deliberately swallows its own failure — a buyer must not lose paid work to
a bookkeeping error — so look in `wrangler tail` for
`FAILED TO RECORD A SETTLED SALE`, which carries enough to rebuild the row by hand.

**The existing policy, recovered without spending anything.** Policy
`58712635805942247654024660654829183281006522701150087479245444894543448647169` is
already registered on chain (`0x94de6bd08073b049fca5a242d7c4429bd4b0137f446c928b5018c1b7a059323c`,
receipt `0x1`) and just was never linked. Re-run `POST /consumer/policies/sync` with the
SAME `policyDraftId` and `txHash` — the fixed route will link it and make it the
account's default. Nothing needs registering again, and no gas is needed. Confirm with
`GET /consumer/policies` and a non-null `defaultPolicyId`.

Only after both of those is it worth spending the 0.05 + 0.10 on
`preflight_payment` → `verify_delivery`.

## Prompt

```
Read NEXT-SESSION.md, then run the paid-call verification it describes.

Context you need:
- Live ASP: https://asp.untch.xyz — Cloudflare Worker, branch feat/production-cutover.
- The OKX CLI is `onchainos`, already installed and logged in. `payment quote` never
  signs, so it is safe to probe with. `payment pay` spends real money.
- Settlement itself is already proven — two real paid calls went through on 2026-08-07,
  by direct URL and through MCP. What is NOT yet proven is the two fixes that run went
  on to find: the sale recorder now reaching the settlement layer, and policy_sync
  linking a policy to the account that registered it. Both are deployed and tested;
  neither has been confirmed against a live payment. Confirming them is the goal.

Do this in order:

1. Confirm the deployment can settle at all:
   curl -s https://asp.untch.xyz/readyz
   attested must be true, financiallyArmed must be true, armingRefusals must be empty.
   If not, run `pnpm deploy:worker` from the repo root and check again. Do NOT run a
   bare `wrangler deploy` — it ships an unattested bundle that refuses every payment
   while looking completely healthy.

2. Check the payer wallet has USDT0 on X Layer:
   onchainos wallet status

3. FIRST, spend nothing: recover the policy that is already registered on chain. Re-run
   POST /consumer/policies/sync with the same policyDraftId and txHash from the last
   session (see NEXT-SESSION.md). It should now link the policy and make it the default.
   Confirm with GET /consumer/policies and a non-null defaultPolicyId. You need an
   account session first, so run the link chain — I sign, you never do.

4. Buy the cheapest service ($0.01) and keep the full output:
   onchainos payment quote "https://asp.untch.xyz/builder/suggest_names"
   then pay it. Ask me before spending if anything about the quote looks wrong.

5. Confirm the money moved AND was recorded. The sale should appear in
   untch_marketplace_sales with the tx hash, the payer, the amount in base units and
   the tool id. If the settlement worked but the table is empty, check `wrangler tail`
   for "FAILED TO RECORD A SETTLED SALE" — the recorder logs loudly and swallows, by
   design, so the buyer never loses paid work to a bookkeeping failure.

6. Repeat once through MCP rather than the direct URL, since that is the path the OKX
   marketplace client actually takes:
   onchainos payment quote "https://asp.untch.xyz/mcp" --tool suggest_names

7. Then the full pipeline, which is the real product and has never run end to end on
   Cloudflare: create_spend_intent (free) → preflight_payment ($0.05) →
   verify_delivery ($0.10). This needs a registered policy, or `useDefaultPolicy` with
   a default set. Getting there means the account chain:
   POST /consumer/account/agentic-link/start → GET .../{id}/challenge?address=0x… →
   I sign inside the TEE with my Onchain OS wallet → POST .../{id}/complete
   {address, message, signature} → POST /consumer/policies/draft
   (do NOT use /consumer/account/link/* — that path reaches the browser extension, which is
   a different wallet with different keys)
   → send the unsigned tx from my own wallet → POST /consumer/policies/sync →
   PUT /consumer/account/default-policy.
   Stop and hand me each thing that needs my wallet to sign. Never ask me for a private
   key and never sign on my behalf.

Report what settled, what was recorded, and anything that failed, with the actual
output. Do not paper over a failure — an honest gap here is worth more than a clean
summary, because the next step after this is resubmitting to OKX.
```

## If something is wrong

**`financiallyArmed: false`, `armingRefusals: ["UNATTESTED"]`** — a bare `wrangler deploy`
was run somewhere. The attestation is compiled into the bundle by `gen:attestation`;
without it the gate refuses every request carrying an authorization while discovery,
pricing and health all look perfect. Fix: `pnpm deploy:worker`.

**A 402 loop that never settles** — the challenge is issued before the arming check by
design (a 402 states a price and moves nothing). Only a request carrying `x-payment`
reaches `assertArmed`. So an endless 402 with a valid authorization means unarmed.

**`policy_draft` returns 401** — no session. Run the account chain from `link/start`.

**A Cloudflare 403 with `error code: 1010`** — the WAF is refusing the client's user
agent, not our code. Some default agents (Python `urllib`) are blocked. Set any
ordinary `user-agent` header.

## Not done, deliberately

- `get_ledger` refuses by name. It reports reserved authority from a process-local
  ledger, and a Worker serves each request from a different isolate — a ported version
  would return near-zero without being able to say why. Not served from
  `untch_marketplace_sales` instead, because what buyers paid Untch is not what a policy
  permits them to spend elsewhere.
- `escalation_status` refuses. The status read alone is servable, but nothing here can
  CREATE an escalation (fan-out needs the channel registry, the timeout worker needs
  Redis), so a poll would answer PENDING forever about an approval that is not coming.
- `approval_decide` refuses. It predates the paid approval model and already 409s every
  service-call-backed request.
- The XMTP `a2a-agent-chat` task channel is not built. A Worker cannot hold a persistent
  connection. This is how OKX delivers `jobId`, so it matters for marketplace task
  delivery, and it needs a different runtime.

## Two research findings worth acting on later, deliberately not done now

**`evm_version = "paris"` in foundry.toml is more conservative than it needs to be.**
It was chosen as a zkEVM-safe guess by someone who could not reach X Layer's docs. X Layer
has since migrated from Polygon CDK zkEVM to an OP Stack rollup running `xlayer-reth`, and
OKX documents every hardfork through Isthmus as active from genesis — so Shanghai (`PUSH0`)
and Cancun (`TSTORE`/`MCOPY`) are both supported. No X Layer-specific deployment failure on
a newer target was found anywhere public.

Not changed here on purpose. It alters bytecode for future deploys only, fixes nothing
live, and recompiling contracts days before a marketplace resubmission is risk with no
payoff. Do it when the contracts are next touched for a real reason.

**The ERC-8004 Reputation registry is live and populated on X Layer mainnet**, at
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, pointing at the same Identity registry
(`0x8004A169...539a432`) our agent is registered in. It has real feedback: agent 936 has 72
records, 963 has 52, 796 has 11. Read interface is `getClients(agentId)`,
`readFeedback(agentId, client, index)`, `readAllFeedback(...)` and `getSummary(...)`.

That is a genuine opportunity for the §12 Trust Bureau, which currently scores from our own
data and cold-start heuristics — real on-chain counterparty reputation is exactly the input
it lacks. It is a feature, not a gap, so it is not in the relisting path. Note the registry
is absent on testnet 1952, and QuickNode's ERC-8004 API does not list X Layer, so reads
would have to go direct to `rpc.xlayer.tech`.

## Relisting ASP 6086

Do not register a new ASP. Do not use ERC-8004 agent 6047 as the ASP id.

The listing payload is the 9 MARKETPLACE_LISTABLE services: 6 paid
(preflight_payment 0.05, verify_delivery 0.10, detect_duplicate 0.02,
redact_payment_metadata 0.02, suggest_names 0.01, brand_pack 0.05) and 3 free
(rank_options, check_domains, seo_tips). Everything else is withheld, account-control,
or production-disabled on purpose.
