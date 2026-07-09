# services/asp — Untch A2MCP seller (real x402 rail on X Layer)

Real, settled, pay-per-call x402 on **X Layer mainnet** (`eip155:196`) via the **OKX hosted
facilitator**. No mock mode, no substitute rail. D0.1 proved the rail with `ping_untch`; Step-2
adds the two policy-plane tools (`create_spend_intent`, `preflight_payment`) and wires the real
`@untch/policy-engine` behind the priced preflight.

## Tools

| Tool | Method / route | Price | What's real | Backed by |
|---|---|---|---|---|
| `ping_untch` | `GET /ping_untch` | `$0.01` | proof-of-rail health check (D0.1) | — |
| `create_spend_intent` | `POST /create_spend_intent` | **bundled** (unpriced) | validate + canonicalize + **hash** a §8.1 SpendIntent | `@untch/canon` |
| `preflight_payment` | `POST /preflight_payment` | `$0.05` | real deterministic **§7.1 policy decision** | `@untch/policy-engine` |

All settle in **USDT0** (`0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, 6dp) via x402 v2:
`PAYMENT-REQUIRED` 402 challenge → EIP-3009 `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE` (settlement tx).

### `create_spend_intent` (bundled)
Takes a full spend intent as JSON (uint256 fields as decimal **strings**, per PRD §9). Validates it,
canonicalizes it, and returns the §8.1 `intentHash` computed by `@untch/canon`'s `hashSpendIntent`
— the *same* hashing path the policy engine uses, so the hash is identical downstream. Returns
`{ intentHash, canonicalIntent, onchain: null }`. It does **not** register anything on-chain —
`SpendIntentRegistry` (§10.2) does not exist yet, so `onchain` is honestly `null`.

### `preflight_payment` ($0.05)
Accepts `{ intentHash }` (from a prior `create_spend_intent` on this instance), or an inline
`{ intent }`, or both (the supplied hash is cross-checked against the recomputed one). Runs the
**real** `evaluateIntentSerialized` (§7.1: per-agent lock → read ledger → evaluate → commit if
approved) and returns the §8.2 decision **verbatim**:
`{ decision, reasons[], ruleTrace[], intentHash, policyId, policyVersion, evaluatedAt, receiptRef, sig }`.
`receiptRef` and `sig` are always `null` — see "still null" below.

## What is real vs fixture vs null vs open

**REAL** (production logic, exercised end-to-end):
- The x402 payment rail (D0.1) and the `$0.05` settlement of `preflight_payment`.
- `create_spend_intent`'s canonicalization + hashing — `@untch/canon`, no reimplementation.
- `preflight_payment`'s decision — the real `@untch/policy-engine` (§7.1, deterministic, **no LLM**,
  I1; fail-closed, I2). Ten of §7.1's thirteen `RULE_EVAL` rules are enforced; the other three are
  surfaced in the trace as `implemented:false` (they need §14/§12/§13 — not this package's bug).

**FIXTURE** (real logic, demo-grade data — resets on process restart; see `src/policy-fixture.ts`):
- **One hardcoded demo policy** (`FIXTURE_RULES`): daily budget 25 USDT, per-call cap 1.00,
  `onPerCallCapExceeded: "ESCALATE"`, escalateAbove 5.00, categories allow `[market-data, security,
  research]`, empty recipient/agent allow-deny, duplicate TTL 60 min, cooldown 5 min, 40 calls/h,
  expiry `2026-12-31`. There is no per-operator policy store yet.
- **In-memory ledger** (`InMemoryLedger`): correct window math (daily budget, rolling-hour rate
  limit, duplicate TTL, per-service cooldown) but **ephemeral** — no Postgres/Redis. Resets on
  restart. Not faked results — real rules over real (but in-memory) state.
- **In-memory intent store** (`InMemoryIntentStore`): lets `preflight_payment` resolve a bare
  `intentHash`. Not the on-chain registry; bounded; resets on restart.

**NULL** (subsystem not built — never faked, always literal `null` + a code comment):
- `preflight_payment.receiptRef` — the receipt writer (§7.4 `UntchReceipts`) does not exist yet.
- `preflight_payment.sig` — the EIP-712 oracle signer (§7.5, Mode C) does not exist yet, and this
  preflight is advisory (Mode A), which never signs.
- `create_spend_intent.onchain` — `SpendIntentRegistry` (§10.2) does not exist yet.

**OPEN** (unresolved question flagged for later, not built here):
- **A2MCP listing wrapper format.** Verified this step (`internal/day0/step2-mcp-format-notes.md`):
  per the OKX Agent Payments Protocol Whitepaper v1.0, an A2MCP seller is a **plain HTTP x402
  service** — the MCP tool wrapper lives on the *buyer* side; no seller-hosted MCP server /
  JSON-RPC / `.well-known` manifest is required. So these plain x402 routes are listing-valid. The
  one residual unknown: whether OKX's live registration *form* requires a declarative per-tool
  input/output JSON **schema** as submitted metadata (a D0.2 form-filling item, not a protocol
  layer). Confirm against the live UI before authoring; do not build now.

## `ping_untch` — kept (decision)

**Kept** as a `$0.01` proof-of-rail health check. `preflight_payment` is now the primary paid proof
(it exercises the same facilitator rail *plus* the policy engine), but `ping_untch` remains the
cheapest, no-input `GET` way to confirm the facilitator round-trip still settles without minting an
intent or touching policy state. It costs nothing to keep and preserves the D0.1 proof surface.

## Custody model

**Self-custody.** The buyer signs an EIP-3009 authorization with its **own** EVM key; the facilitator
submits it (gasless for the buyer). The OKX API triple authenticates only the **seller's**
facilitator calls — it never moves money.

## Deploy (changed in Step-2)

The seller now has real workspace dependencies on `@untch/canon` and `@untch/policy-engine`, whose
private TS source must be present at build time. So it is **no longer a standalone island** — it is a
member of the pnpm workspace and **deploys from the repo ROOT**:

- Root `railway.json` → `startCommand: pnpm --filter @untch/asp start` (Railpack builder).
- Root `.railwayignore` trims the upload (excludes `internal/`, `contracts/`, `fixtures/`, `.env*`).
- Railway installs the whole workspace (`pnpm install --frozen-lockfile`) and runs the filtered
  start. Deploy: `railway up` from the repo root (service `untch-asp`, env `production`).

Seller env on Railway = OKX HMAC triple + `PAY_TO_ADDRESS`. The buyer key never leaves the local
gitignored `services/asp/.env`.

## Run

```bash
pnpm install                                   # from repo root (workspace)
pnpm --filter @untch/asp test                  # unit tests (real engine, no network)
pnpm --filter @untch/asp typecheck

# local buyer flows (buyer signs locally; seller must be reachable to the OKX facilitator):
pnpm --filter @untch/asp gen-buyer-wallet      # writes BUYER_PRIVATE_KEY to services/asp/.env
pnpm --filter @untch/asp pay                    # D0.1 ping_untch $0.01 paid call
pnpm --filter @untch/asp preflight:proof        # Step-2: create intent → pay $0.05 preflight
```

## Evidence

- **D0.1** (`$0.01` `ping_untch`): `internal/day0/D0.1-evidence/` — settlement tx
  `0x9db78b52…`, `CONFIRMATION.md`.
- **Step-2** (`$0.05` `preflight_payment`): `internal/day0/D0.1-evidence/step2-preflight-proof.json`
  + `step2-preflight-transcript.md` — real settled call, decision **APPROVED**, settlement tx
  `0x2e6dcfe8e1250deeb85a790b72e3ac1ebcd96031041cada7db028506bb0b8c46` (X Layer, receipt status
  `0x1`, block 64828052), independently verified via `rpc.xlayer.tech`.

## Environment prerequisite

The seller's `verify`/`settle` calls hit `https://web3.okx.com/api/v6/pay/x402/*`. That host must be
reachable from wherever the **seller** runs — it is **not reachable** from the operator's Nigerian /
commercial-VPN egress (`HTTP 000`), which is exactly why the seller runs on Railway while the buyer
stays local. See `internal/day0/BLOCKERS.md` and the D0.1 notes.
