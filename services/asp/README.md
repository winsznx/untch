# services/asp — Untch A2MCP seller (real x402 rail on X Layer)

Real, settled, pay-per-call x402 on **X Layer mainnet** (`eip155:196`) via the **OKX hosted
facilitator**. No mock mode, no substitute rail. D0.1 proved the rail with `ping_untch`; Step-2
added the two buyer tools (`create_spend_intent`, `preflight_payment`) behind the real
`@untch/policy-engine`. **The policy plane is now real and durable:** the old hardcoded fixture policy
is gone — policies are stored in Postgres (`@untch/policy-store`), keyed by their on-chain policyId,
and anchored by real `PolicyRegistry` (§10.1) txs. `preflight_payment` / `create_spend_intent` read
real stored policies by `policyId`; `create/update/pause_policy` write them.

## Tools

| Tool | Method / route | Price | What's real | Backed by |
|---|---|---|---|---|
| `ping_untch` | `GET /ping_untch` | `$0.01` | proof-of-rail health check (D0.1) | — |
| `create_spend_intent` | `POST /create_spend_intent` | **bundled** | validate + **hash** a §8.1 SpendIntent, **bound to a real stored policy** | `@untch/canon` + `@untch/policy-store` |
| `preflight_payment` | `POST /preflight_payment` | `$0.05` | real **§7.1 decision** against a **real stored policy** | `@untch/policy-engine` + `@untch/policy-store` |
| `verify_delivery` | `POST /verify_delivery` | `$0.10` | real **§13/§7.3 T0** verification → a **real VERIFY receipt** | `@untch/proof-engine` + `@untch/receipt-writer` |
| `generate_dispute_packet` | `POST /generate_dispute_packet` | `$0.50` | assemble an intent's **real evidence bundle** (decision/verify/receipts/escalation/timeline) → hash → **`AuditAnchored`** | `@untch/reports` |
| `reconcile_agent_spend` | `POST /reconcile_agent_spend` | `$0.25`² | assemble an agent's **real spend/blocked-waste report** over a period → hash → **`AuditAnchored`** | `@untch/reports` |
| `create_spend_policy` | `POST /create_spend_policy` | unpriced¹ | **real `PolicyRegistry.registerPolicy` tx** + durable store | `@untch/policy-store` |
| `update_policy` | `POST /update_policy` | unpriced¹ | **real `updatePolicy` tx** (version bump) + sync | `@untch/policy-store` |
| `pause_policy` / `resume_policy` | `POST /pause_policy` · `/resume_policy` | unpriced¹ | **real `pausePolicy`/`resumePolicy` tx** + sync | `@untch/policy-store` |

¹ §11 prices `create/update/pause_policy` (0.50 / 0.10). Pricing is **deliberately deferred** with the
dashboard wallet-connect flow (§15): these are operator-admin actions signed by the operator's own
wallet, not buyer x402 calls. In this interim build they are **unpriced admin routes** signed by the
demo/burner operator wallet — see **Operator signing** below.

² §11 prices `reconcile_agent_spend` at $0.25/day · $1.00/wk. The x402 middleware prices one static value
per route, so this build charges the **$0.25 base rate for both** day and week reports; the differentiated
week price is deferred (same posture as ¹). Both report tools assemble+hash from durable history and reuse
`UntchReceipts.anchorAudit` (§10.3 `AuditAnchored`) — see `packages/reports/README.md` for the reuse
decision, output shapes, honest gaps, and the two real testnet anchor proofs. Per-call seller-side
anchoring is off unless `REPORT_ANCHOR_WRITER_KEY` is set (the seller holds no writer key by default).

Buyer tools settle in **USDT0** (`0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, 6dp) via x402 v2:
`PAYMENT-REQUIRED` 402 challenge → EIP-3009 `PAYMENT-SIGNATURE` → `PAYMENT-RESPONSE` (settlement tx).

### `create_spend_intent` (bundled)
Takes a full spend intent as JSON (uint256 fields as decimal **strings**, per PRD §9) plus a
`policyId`. Validates + canonicalizes it, returns the §8.1 `intentHash` computed by `@untch/canon`'s
`hashSpendIntent` — the *same* hashing path the policy engine uses — and **binds it to a real stored
policy**: the `policyId` must resolve to a stored policy whose `policy_hash` equals the intent's
`policyHash` (else `404 POLICY_NOT_FOUND` / `400 POLICY_BINDING_MISMATCH`). Returns
`{ intentHash, canonicalIntent, policyId, policyVersion, onchain: null }`. `onchain` is `null` because
`SpendIntentRegistry` (§10.2) is not wired to this tool yet.

### `preflight_payment` ($0.05)
Accepts a `policyId` plus `{ intentHash }` (from a prior create on this instance), an inline
`{ intent }`, or both (the supplied hash is cross-checked). It **loads the real stored policy named by
`policyId`** and runs the **real** `evaluateIntentSerialized` (§7.1: per-agent lock → read ledger →
evaluate → commit if approved) against it, returning the §8.2 decision **verbatim**:
`{ decision, reasons[], ruleTrace[], intentHash, policyId, policyVersion, evaluatedAt, receiptRef, sig }`.
Resolution: missing `policyId` → `400`; unknown `policyId` → the engine fail-closes to
`BLOCKED_NO_ACTIVE_POLICY` (I2); an intent bound to a different policy hash → `400
POLICY_BINDING_MISMATCH`. `sig` is always `null` (§7.5 oracle signer unbuilt); `receiptRef` is a real
queued ref when the §7.4 writer is wired, else `null`.

### `verify_delivery` ($0.10)
The first tool that produces a **real delivery-verification receipt** — one whose `verifyResult` /
`proofTier` finally reflect what happened, not the default `0` every prior (decision-kind) receipt has
carried. Accepts a `policyId`, an intent (`{ intentHash }` from a prior create on this instance, an
inline `{ intent }`, or both — the same resolver preflight uses), the committed `acceptanceCriteria`
document, and the `delivery` (`{ payload }` and/or `{ payloadHash }`). It resolves the intent, recovers
the **committed §8.1 `acceptanceHash`**, and runs the **real, deterministic** `@untch/proof-engine` T0
(no LLM, I1) — ajv schema + required-field / size / regex / enum checks + exact-hash for deterministic
deliverables, all gated behind acceptance-criteria binding (the presented criteria must hash back to
the committed `acceptanceHash`, so a buyer cannot swap the spec after delivery).

Response:
```jsonc
{
  "intentHash": "0x…",
  "final": "VERIFY_PASSED",            // | VERIFY_FAILED | VERIFY_SKIPPED_UNCOMMITTED | VERIFY_TIER_NOT_IMPLEMENTED
  "recommendation": "RELEASE",         // | WITHHOLD | NONE
  "requiredTier": 0, "achievedTier": 0, "proofTier": 0,
  "verifyResult": 1,                   // proof-engine code: 1=PASS 2=FAIL 3=SKIPPED_UNCOMMITTED 4=NOT_IMPLEMENTED
  "tierResults": [                     // the FULL §13 ladder — T1–T4 present as NOT_IMPLEMENTED, never absent
    { "tier": "T0", "result": "PASS" },
    { "tier": "T1", "result": "NOT_IMPLEMENTED", "implemented": false, "note": "…" },
    { "tier": "T2", "result": "NOT_IMPLEMENTED", "implemented": false, "note": "…" },
    { "tier": "T3", "result": "NOT_IMPLEMENTED", "implemented": false, "note": "…" },
    { "tier": "T4", "result": "NOT_IMPLEMENTED", "implemented": false, "note": "…" }
  ],
  "diffs": [],                         // machine-readable §7.3 diffs on a FAIL
  "hygieneEvent": false,               // true only on VERIFY_SKIPPED_UNCOMMITTED
  "payloadHash": "0x…",
  "receiptRef": { "receiptId": "0x…", "status": "QUEUED" } // or null when the §7.4 writer is unwired
}
```
**The cached intent is authoritative for T0.** When the supplied `intentHash` hits this instance's
store (a prior `create_spend_intent`), T0 verifies against the **stored committed** intent's
`acceptanceHash` — never whatever the caller also sent inline. If an inline intent is supplied
alongside a store hit, it must match the stored record **exactly** (its recomputed hash must equal both
the stored record's hash and the `intentHash` parameter), else `400 ACCEPTANCE_MISMATCH` — a tampered
`acceptanceHash` is rejected, never silently preferred. Inline data drives T0 **only on a genuine store
miss**, and the response then carries `"intentProvenance": "caller-supplied"` (vs `"store-committed"`)
— committed into the VERIFY receipt's metadata hash so a store-miss result is never mistaken for a
committed-intent one, and Trust Bureau (built next) can weight it as lower-confidence.

Resolution / errors: missing `policyId` → `400`; unknown `policyId` → `404 POLICY_NOT_FOUND`; an intent
bound to a different policy hash → `400 POLICY_BINDING_MISMATCH`; inline ≠ the stored committed record →
`400 ACCEPTANCE_MISMATCH`; store miss with only an `intentHash` → `404 INTENT_NOT_FOUND` (fail closed —
T0 never runs); no `payload`/`payloadHash` → `400 DELIVERY_REQUIRED`. **REQUIRED_TIER is T0** in this build — a policy requiring a higher tier returns
`VERIFY_TIER_NOT_IMPLEMENTED` (WITHHOLD), never a silent pass, because T1–T4 are honest stubs
(`@untch/proof-engine` README). A `0x0` committed `acceptanceHash` returns `VERIFY_SKIPPED_UNCOMMITTED`
— a logged buyer-hygiene event (§7.3), not a pass. On success the VERIFY receipt is durably enqueued
(§7.4) and anchored by the worker to `UntchReceipts` (§10.3) carrying the real `verifyResult`/`proofTier`.

**End-to-end proof:** `pnpm --filter @untch/asp verify:e2e` (`src/run-verify-e2e-proof.ts`) — a real
paid `verify_delivery` on the live seller → real T0 PASS → anchored VERIFY receipt, with the
`verifyResult` + `proofTier` **decoded from the chain log via raw `eth_getLogs`** (not read from the
service), same independent-verification standard as every prior on-chain proof.

## What is real vs fixture vs null vs open

**REAL** (production logic, exercised end-to-end):
- The x402 payment rail (D0.1) and the `$0.05` settlement of `preflight_payment`.
- `create_spend_intent`'s canonicalization + hashing — `@untch/canon`, no reimplementation.
- `preflight_payment`'s decision — the real `@untch/policy-engine` (§7.1, deterministic, **no LLM**,
  I1; fail-closed, I2). Ten of §7.1's thirteen `RULE_EVAL` rules are enforced; the other three are
  surfaced in the trace as `implemented:false` (they need §14/§12/§13 — not this package's bug).

- **The policy itself is now REAL + DURABLE** — the fixture is gone. Policies live in Postgres
  (`@untch/policy-store`) keyed by their **on-chain policyId**, anchored by real `PolicyRegistry`
  (§10.1) txs. See **Policy store** below.

**FIXTURE-FREE-BUT-STILL-DEMO** (real logic, one demo shortcut, clearly labeled):
- **`create_spend_policy` no longer signs** — it builds unsigned calldata for the caller's own wallet
  (per-caller ownership; see **Operator signing** below). Only **`update/pause/resume_policy`** still
  sign server-side with the interim demo/burner wallet `0x98F43e…`, a **TEMPORARY stand-in** that can
  only mutate a policy that operator itself owns.

**STILL EPHEMERAL** (real logic, demo-grade *state* — resets on restart; `src/ledger-state.ts`). Only
the ledger window + intent cache remain in-memory; this is a *separate* later step (§7.1/§8), not the
policy:
- **In-memory ledger** (`InMemoryLedger`): correct window math (daily budget, rolling-hour rate limit,
  duplicate TTL, per-service cooldown) but ephemeral — no Redis/Postgres backstop yet.
- **In-memory intent store** (`InMemoryIntentStore`): resolves a bare `intentHash`; bounded; not the
  on-chain `SpendIntentRegistry` (§10.2).

**NULL** (subsystem not built — never faked, always literal `null` + a code comment):
- `preflight_payment.sig` — the EIP-712 oracle signer (§7.5, Mode C) does not exist yet, and this
  preflight is advisory (Mode A), which never signs.
- `create_spend_intent.onchain` — `SpendIntentRegistry` (§10.2) is not wired to this tool yet.
- `preflight_payment.receiptRef` — `null` only when the §7.4 receipt writer is not wired; a real
  queued ref otherwise.

**OPEN** (unresolved question flagged for later, not built here):
- **A2MCP listing wrapper format.** Verified this step (`internal/day0/step2-mcp-format-notes.md`):
  per the OKX Agent Payments Protocol Whitepaper v1.0, an A2MCP seller is a **plain HTTP x402
  service** — the MCP tool wrapper lives on the *buyer* side; no seller-hosted MCP server /
  JSON-RPC / `.well-known` manifest is required. So these plain x402 routes are listing-valid. The
  one residual unknown: whether OKX's live registration *form* requires a declarative per-tool
  input/output JSON **schema** as submitted metadata (a D0.2 form-filling item, not a protocol
  layer). Confirm against the live UI before authoring; do not build now.

## Policy store (real, durable, on-chain-anchored)

`@untch/policy-store` replaces the old fixture policy. Policies are stored in the **same Railway
Postgres** the receipt writer uses (**no second instance** — its `002_policies.sql` lands in the
shared migration history) and anchored on-chain via the deployed `PolicyRegistry` (§10.1) at
`0xe1d74c90801db0fa806c72eb818b7671b8233532` (the post-lint-fix redeploy; the stale `0xc571…` is
superseded).

**policyId consistency.** The Postgres `policies.id` **IS** the on-chain policyId —
`uint256(keccak256(abi.encodePacked(owner, ownerNonce)))`. The nonce is read from the **live
contract** before registering; the id is taken from the confirmed `PolicyRegistered` event (asserted
to equal the prediction). There is **no off-chain counter** and no separate mapping — the id cannot
drift from the chain.

Each mutation keeps three subsystems consistent: `@untch/canon` hashes the ruleset (reused, not
reimplemented) → `PolicyRegistry` runs the real register/update/pause tx → Postgres stores the row
**after** the tx confirms (so a row never claims an anchor that did not land).

## Operator signing — per-caller ownership (`create_spend_policy` no longer signs)

`PolicyRegistry.registerPolicy` is gated to `msg.sender == owner`: **direct, no relayer, no
signature path**. The only way a caller becomes the on-chain owner is to submit the tx with **their own
key**. `create_spend_policy` now respects that — it is a **BREAKING CHANGE to the tool's calling
convention** (this build's own callers were the primary users of it, so they moved with it):

1. `POST /create_spend_policy { agent, rules }` → the seller **builds the UNSIGNED `registerPolicy`
   calldata** (`unsignedTx.calldata` + the decoded args + the canonical `policyHash`) and returns it. It
   holds a **key-free `RegistryReader`** — it is structurally unable to sign. No `policyId` and no `tx`
   yet: those exist only after the caller submits.
2. the **caller's own wallet** signs + submits that calldata → the caller becomes the genuine on-chain
   owner.
3. `POST /sync_policy_registration { txHash, rules }` → the seller reads the confirmed `PolicyRegistered`
   event and records the row with `owner` = **the real submitter from the event** (never assumed). The
   rules must hash to the anchored `policyHash` (`RULES_HASH_MISMATCH` otherwise).

This brings the API path to parity with the dashboard, whose connected wallet already signs directly.
Two distinct callers provably end up as two distinct on-chain owners — see the e2e proof below.
`create_spend_policy` / `sync_policy_registration` need **no signing key** (only `DATABASE_URL` for the
durable row); with the store unwired they return `503 POLICY_STORE_NOT_CONFIGURED`.

`update_policy` / `pause_policy` / `resume_policy` still sign server-side with the interim demo/burner
wallet `0x98F43e…` (`OPERATOR_PRIVATE_KEY`) — a **TEMPORARY stand-in** that can only mutate a policy that
operator itself owns. `OPERATOR_PRIVATE_KEY` unset ⇒ those three return `503
POLICY_SIGNER_NOT_CONFIGURED`; create/sync still work. Bringing them to the same unsigned-calldata parity
is the same follow-up the dashboard's `buildUpdatePolicy` / `buildPausePolicy` already model.

### Owner-based escalation routing (§27) — the operator tables are now load-bearing

Now that policies have genuine, distinct owners, escalation notification routes to the **real owner**, not
a hardcoded operator:

- `escalation-routing.ts` resolves the escalating policy's **owner → operator** (via the owner's
  `dashboard` binding, `operatorForOwner`), records that operator as the policy's approver, and fans out
  only to **that operator's bound channels** (`channelsForOperator`). An as-yet-unbound owner (the interim
  single-operator reality) routes to the configured operator and is first-classed for a later §15
  onboarding — a bound owner routes to itself.
- the §27 **dashboard** authority path now checks **policy ownership**: a SIWE session may resolve an
  escalation only if its wallet's operator is an approver of THAT escalation's policy (`verifyOwnership`
  → `operatorForOwner` + `approversFor`). A wallet that owns a *different* policy is refused
  (`IGNORED_UNBOUND`), proven as an explicit negative case in `test/escalation-routing.test.ts`.

The `escalation_operators` / `escalation_operator_bindings` / `policy_approvers` tables (migration 004),
seeded with one row, are therefore **genuinely load-bearing now — not placeholders**. Telegram / Discord
/ Slack / dashboard channel mechanics are unchanged; only the *routing* (which operator's bindings get
notified) changed.

### Real end-to-end proof

`pnpm --filter @untch/asp policy:multitenant` — two different real wallets each create a real policy
through the changed flow; each ends up as the genuine on-chain owner, **independently verified via raw
RPC** (`getPolicy(policyId).owner`), receipt at
`contracts/deploy/multi-tenant-policy-testnet-receipt.json`. One funded key + a freshly-generated,
auto-funded second caller is enough; the proof refuses mainnet.

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

Seller env on Railway = OKX HMAC triple + `PAY_TO_ADDRESS` + `DATABASE_URL` (policy read/write, shared
with the receipt writer). `OPERATOR_PRIVATE_KEY` (the interim demo wallet) is set **only** where the
policy mutation tools should sign — without it the seller reads policies but returns `503` on
`create/update/pause_policy`. The buyer key + operator key never leave the gitignored `.env` files.

## Run

```bash
pnpm install                                   # from repo root (workspace)
pnpm --filter @untch/asp test                  # unit tests (real engine, no network)
pnpm --filter @untch/asp typecheck

# local buyer flows (buyer signs locally; seller must be reachable to the OKX facilitator):
pnpm --filter @untch/asp gen-buyer-wallet      # writes BUYER_PRIVATE_KEY to services/asp/.env
pnpm --filter @untch/asp pay                    # D0.1 ping_untch $0.01 paid call
pnpm --filter @untch/asp preflight:proof        # Step-2: create intent → pay $0.05 preflight
pnpm --filter @untch/asp guarded:e2e            # §14 Mode B: paid call through @untch/x402-guard

# policy store: real create_spend_policy tx → real preflight against the stored policy (task 5 proof):
pnpm --filter @untch/policy-store migrate        # applies 002_policies.sql to the Railway Postgres
pnpm --filter @untch/asp policy:e2e              # needs OPERATOR_PRIVATE_KEY + DATABASE_URL
```

The buyer proof scripts (`preflight:proof`, `receipt:e2e`, `guarded:e2e`) bind their intents to a real
stored policy via `DEMO_POLICY_ID` + `DEMO_POLICY_HASH` (printed by `policy:e2e`, recorded in
`contracts/deploy/policy-store-testnet-receipt.json`) — no fixture is reintroduced.

### Buyer-side middleware — §14 Mode B (real dogfood, I5)

The buyer no longer signs whatever 402 it receives. `src/guard-buyer.ts` routes every outbound paid
call through **`@untch/x402-guard`**: on a 402 it runs the Challenge Binding Check against what the
buyer independently authorized, calls the real `preflight_payment`, and only on **APPROVE** does the
buyer's own signer (`makeBuyerFetch`, the sole holder of the key) run. BLOCK ⇒ structured refusal;
ESCALATE ⇒ a non-blocking poll handle. `guarded:e2e` is the live end-to-end proof of this path.

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
