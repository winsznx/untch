# Untch — Product Requirements Document

**Version:** 2.7 (approver model clarified: one-operator-many-channels is v1, schema stays N-approver-ready for v2/Enterprise) · **Status:** Approved direction, pre-build · **Owner:** Tim (@winsznx) · **Target:** OKX AI Genesis Hackathon → standalone company
**v2.6 changelog:** independently verified against the actual APP Whitepaper v1.0 PDF (web3.okx.com/whitepaper/okx-app-whitepaper.pdf), not just trusted secondhand — A2MCP requires no seller-side MCP protocol wrapper (no tool manifest, no JSON-RPC tools/list, no .well-known); plain x402-priced HTTP routes are listing-valid, matching what D0.1 and Step-2 already built (§6.4 updated with citation). One residual open item on this: whether OKX's live registration *form* separately asks for a declarative per-tool schema — a form-filling question, not a protocol requirement. Separately, reading the full whitepaper surfaced a real tension worth flagging before any A2A work starts: it describes `escrow` as a fully-specified intent backed by an audited custody contract, but a more recently dated OKX marketing page tags escrow specifically "(coming soon)" while other payment types read as already live — and everything proven real so far (D0.1, Step-2) has used `charge` (direct signed authorization, no custody contract), consistent with `escrow` being the one intent still rolling out operationally. New open question added (§23.4a) — resolve with one direct test (attempt a real minimal escrow-shaped payment), not more reading, before S2 implementation starts. Status line promoted from "Day 0 status" to "Build status," now tracking feature-build progress too.
**v2.4a changelog:** two policy schema fields added, confirmed correct during Step-1b implementation, not previously specified in §8: `recipients: {allow, deny}` (§7.1 requires a recipient check; nothing in §8 modeled it — shaped like `categories`) and `perCallCap`'s `onPerCallCapExceeded: "ESCALATE"|"BLOCK"` selector (§7.1 says per-call cap outcome is policy-conditional; mirrors `vendors.onBelowFloor`'s pattern, defaults to `"BLOCK"`). Both are now live in `@untch/policy-engine`, 10/13 RULE_EVAL rules implemented and tested (106/106 passing); the 3 remaining stubs (replay/CBC, vendor LCB, proof tier) are correctly deferred pending §14/§12/§13 respectively, not a gap.
**v2.4 changelog:** D0.1 PASS with a real, independently-verified settled call (§11/§29 updated; §23 Q3 resolved); "OKX Payment SDK" language corrected everywhere to the confirmed mechanism — the x402 protocol via OKX's hosted facilitator (endpoint `https://web3.okx.com/api/v6/pay/x402/*`, not the stale `/facilitator/...` prefix an earlier pass assumed); new discovered constraint promoted into §25 risks: OKX's facilitator hosts are unreachable from Nigerian IPs and from commercial-VPN ranges at the network layer, so any component that calls OKX endpoints directly (seller service, and by the same logic Mode D Broker Guard) must run on non-blocked infra — Railway confirmed working, matching the existing default deploy stack — while buyer-side signing can stay local since it only needs the seller's own URL plus public RPC; D0.3's remaining ops-wallet funding target corrected from testnet to mainnet OKB, since D0.1 proved the whole rail runs on mainnet (no testnet facilitator exists).
**v2.3 changelog:** Photon reframed explicitly as a *transport*, never a money authority — new "Control-channel authority boundary" subsection under §27 with the 7-point validity check; approval binding widened from handle-only to a full tuple (channel, provider, spaceId, handle, verified wallet, last-verified-at) to survive Photon shared-line/line-pool behavior on lower tiers; poll/mini-app approvals downgraded from "primary" to "enhanced path, confirmed at D0.6" with text-code approvals as the judge-safe baseline; D0.6 checklist expanded to 10 explicit pass/fail rows; demo line updated.
**v2.2 changelog:** Photon iMessage integrated as primary control channel (Spectrum, managed/no-Mac) with poll-based structured approvals, handle binding, single-use codes, dual-channel rule, per-channel caps, and full monitoring/alert catalog (§27); contract audit & test pipeline formalized — solc pinning, Slither + Aderyn CI gates, unit/fuzz/invariant/signature-differential/canonicalization-differential/fork/gas/coverage battery + testnet soak + mainnet checklist (§28); Day 0 gate defined with PASS/FAIL evidence (§29); escalation machine, data model, threat model, demo, metrics, build order updated accordingly.
**v2.1 changelog:** rebrand AgentSpend → **Untch** across product, contracts (UntchVault, UntchReceipts), middleware (@untch/x402-guard), and system language (Untch Guard / Bureau / Vault / Receipts / Broker Guard); brand tagline elevated: "The model never touches the money."; Brand & naming section added.
**v2 changelog:** proof-gated spend control framing; SpendIntent as first-class bounded object + on-chain registry; proof tiers T0–T4; Mode D Broker Guard (APP-native); Untch Bureau scores both sides w/ lower-confidence-bound enforcement; receipt schema versioned + policyId type fix; canonicalization rules; official track names; judge-demo + independent-verification sections; custody language precision; gas claims made measurable-not-asserted.
**Build status (as of 2026-07-09):** **Day 0 — all four hard-gate items closed.** D0.1 PASS (real settled A2MCP call on X Layer mainnet via OKX's hosted x402 facilitator, tx `0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc`, independently verified on rpc.xlayer.tech) · D0.2 PASS (listing artifacts drafted) · D0.3 PASS (ops wallet funded on mainnet, gate condition corrected from an earlier testnet assumption) · D0.4 PASS locally · D0.5 PASS, permanent CI. D0.6–D0.9 not yet issued.
**Feature build — Step 1 & 2 done.** `@untch/policy-engine`: 10 of 13 §7.1 RULE_EVAL rules real and tested (117 tests green across canon/policy-engine/asp combined); the 3 remaining (replay/CBC, vendor LCB, proof tier) correctly deferred pending §14/§12/§13. Two new real endpoints live on the Railway seller alongside `ping_untch`: `create_spend_intent` (canonicalize+hash, unpriced) and `preflight_payment` ($0.05, calls the real engine against a fixture policy + in-memory ledger) — both proven with real settled x402 calls, not mocked. `receiptRef`, `sig`, and `create_spend_intent`'s on-chain anchor are honestly `null` — no contracts deployed yet. **MCP-format question resolved:** OKX's Agent Payments Protocol Whitepaper v1.0 confirms A2MCP sellers are plain priced HTTP services; the buyer-side holds the MCP tool wrapper, not the seller. No additional protocol layer is required beyond what's already live. Not yet started: all four contracts, Trust Bureau, Proof Engine, x402-guard middleware, Broker Guard, receipt writer, dashboard.

**Feature build — Proof Engine T0 + `verify_delivery` done.** `@untch/proof-engine` ships **T0 (Schema Proof, §13/§7.3) real and tested** — ajv schema + required-field/size/regex/enum checks + exact-hash for deterministic deliverables, all gated behind acceptance-criteria binding (the presented criteria must hash back to the committed §8.1 `acceptanceHash`), plus the `VERIFY_SKIPPED_UNCOMMITTED` buyer-hygiene path. **T1–T4 are explicit `NOT_IMPLEMENTED` stubs** (tagged `implemented:false` in the tier ladder, never faked as PASS), with a manifest test pinning exactly that T0 is real and T1–T4 are stubbed — same discipline as the policy engine's rule manifest. T1/T2 are deferred because each needs a subsystem nothing in this build can exercise yet (T1 a vendor/worker signing-key registry; T2 a source manifest); T3/T4 are later stages (§22.7). `verify_delivery` is **live as a real priced $0.10 x402 tool** on the seller, calling T0 for real (no LLM, I1). The **receipt writer now emits real VERIFY receipts** — `verifyResult`/`proofTier` finally reflect what happened (PASS/FAIL/skipped/T0) instead of the default `0` every prior (decision-kind) receipt carried. Confirmed while wiring this: `acceptanceCriteriaHash` was **already** threaded through the `intentHash` and captured by `create_spend_intent` since Step 2/5 (part of the §8.1 struct that `hashSpendIntent` covers) — no fix was needed; only durable `spend_intents` persistence remains a separate later step. Proven end-to-end with a real paid `verify_delivery` on the live seller → real T0 PASS → anchored VERIFY receipt, `verifyResult`/`proofTier` decoded independently from the chain log via raw `eth_getLogs`.

**Explicitly out of this doc:** visual design system (deferred by owner — functional UI requirements only).

---

## Executive summary

**Untch is accounts payable for autonomous agents. It keeps agent funds untouched until policy, proof, and spend limits clear the payment.**

OKX.AI makes it possible for agents to discover services, call paid tools, negotiate A2A work, and settle in stablecoins on X Layer. But once agents can spend, operators need controls: budgets, allowlists, duplicate protection, vendor trust, delivery verification, receipts, and reconciliation. Untch provides that control plane.

It ships as: **(1)** a paid A2MCP ASP for preflight, verification, vendor scoring, redaction, and reports; **(2)** an A2A audit line (three packaged SKUs) for custom spend reviews; **(3)** open-source, operator-authorized payment middleware for APP/x402 flows; **(4)** X Layer contracts for policy anchoring, bounded spend intents, public receipts, and UntchVault enforcement.

Core invariant: **the LLM never touches a money decision.** Every approve/block/escalate comes from deterministic policy evaluation against a **bounded SpendIntent**, and produces a machine-readable rule trace and a public receipt.

Positioning inside the OKX stack: Untch does not rebuild payments. It is **APP-compatible spend governance** — a multiplier for OKX's Agent Payments Protocol, Payment SDK, escrow, and Agentic Wallet, not a replacement for any of them.

Startup path: as more agents spend through Untch, we accumulate the **receipt-backed financial graph of the autonomous economy** — budgets, spend histories, vendor reliability, buyer hygiene, revenue quality — the substrate for future underwriting.

Judge-killer lines: *"The model never touches the money."* · *"OKX.AI lets agents do business. Untch makes that business controllable."* · *"Public proof. Private work. Accountable payment."* · *"Untch does not trust agent text. It trusts bounded intents, signed receipts, and verifiable delivery traces."*

---

## Brand & naming

**Name origin:** Untch comes from **untouched** — untouched funds → untch'd money → **Untch**. Born from the primitive: agents can think, plan, request, and negotiate, but funds stay untouched until deterministic policy clears the payment (agent allowed · vendor trusted · budget holds · not a duplicate · challenge binds · delivery meets committed criteria · receipt written on-chain).

**Public explanation (canonical, use verbatim):** "Untch comes from 'untouched.' In autonomous finance, the agent can make a request, but the money stays untouched until policy, proof, and limits clear the transaction."

**Primary tagline:** **The model never touches the money.**
Tagline bank: "No policy, no payment." · "Agent money, untouched until cleared." · "Every agent payment, checked before it moves." · "Where autonomous spend gets cleared." · "Funds stay untouched until the rules pass."

**Positioning (built to outgrow OKX.AI):** *Financial controls for autonomous systems* · *The spend-control layer for agent commerce* · *Untch is the operating layer for agent money.* Never "an AI finance app."

**Command-center narrative (use for the Photon-specific pitch):** "Untch lets operators govern agent money from where they already live: dashboard, Telegram, webhook, or iMessage. The agent can request spend, but the model never touches the money. The policy engine decides, Photon carries approvals, and X Layer receipts prove the trail."

**Website hero:** "Autonomous agents can spend. Untch keeps the money under control." — sub: "Give every agent a budget, policy, proof requirement, and receipt trail. Untch checks every payment before it moves and anchors every decision on X Layer." — CTAs: **Create a spend policy** · **View public receipts**.

**System language:** **Untch Guard** (Mode B middleware) · **Untch Bureau** (two-sided reliability) · **Untch Vault** (Mode C enforcement) · **Untch Receipts** (X Layer anchoring) · **Untch Broker Guard** (Mode D).

**Launch-thread narrative (X, #OKXAI):** Agents are about to become economic actors — paid APIs, hiring agents, buying data, settling work on-chain. Nobody serious gives an autonomous wallet money without controls. Untch keeps agent funds untouched until the payment passes deterministic rules: budget, vendor trust, duplicate checks, metadata safety, delivery proof, policy limits. The model can request. The policy decides. X Layer receipts prove what happened. **Untch: the model never touches the money.**

---

## 1. One-liner & thesis

**Untch is the control plane for autonomous agent money: every payment is policy-checked before execution against a bounded intent, verified on delivery against a declared proof tier, and receipted on X Layer.**

Untch comes from *untouched*: the agent can reason, request, and negotiate — the funds stay untouched until deterministic policy clears the spend.

Thesis: the bottleneck of the agent economy is no longer "can an agent pay?" — OKX solved that. The bottleneck is **can an agent pay safely?** Before an agent spends, Untch answers four questions: is this payment *allowed* (policy), is this counterparty *trustworthy* (bureau), does the output meet the agreed *proof standard* (tiers), and should this receipt *count toward reputation* (receipt-backed signals only).

Headline claims (each must survive judge scrutiny):
1. **The LLM never touches a money decision** (invariant I1). LLMs write narrative report text only — sandboxed, no tools.
2. **Enforcement, not advice.** In Vault mode an agent physically cannot move funds outside policy; in Broker Guard mode credentials are never forwarded without a policy pass.
3. **Bounded intents.** An agent cannot freestyle-send because a model said so — it spends against a canonical, hashable `SpendIntent` with maxAmount, deadline, and committed acceptance criteria.
4. **Receipt-backed reputation.** Reputation moves only on verifiable, receipted work — never on vibes or raw star counts.

## 2. Problem

1. **The funding-confidence gap.** OKX.AI's loop (task → escrow → delivery → confirmation/arbitration → payment) works per-transaction, but the operator funding an agent has no global controls: no daily budget, no per-call cap, no category restrictions, no duplicate protection, no approval threshold.
2. **Payment-flow attack surface.** x402/APP-style flows (HTTP 402 challenge → EIP-3009 signed transfer) carry documented replay, context-binding, and PII-in-metadata risks. Buyer agents currently sign whatever challenge they receive.
3. **Counterparty opacity.** Marketplace reputation is a sold-count and a star rating with tiny n. Early agent-reputation registries are known to be shallow and Sybil-distortable. There is no dispute-odds signal, no wallet-continuity check, no claims-vs-delivery consistency before an agent commits funds.
4. **No *programmable* verification before release.** OKX A2A supports user confirmation before escrow release; what's missing is deterministic, machine-checkable acceptance — committed criteria, schema checks, signed traces, attestations — producing machine-readable evidence for confirmation and arbitration.
5. **No books.** Agents that earn and spend generate zero accounting artifacts. Operators can't see waste, ROI, or exposure; vendors can't prove revenue quality.

Machine-to-machine trust is the lane. Crowded field: "my agent can research/trade/create." Untch's answer: *cool — who decides when that agent may spend, whom it may pay, what counts as delivery, and how bad actors get filtered?*

## 3. Goals / Non-goals

**Goals (all v1):**
- G1: Live, listed ASP on OKX.AI (A2MCP pay-per-call) any agent can call — eligibility gate and primary revenue surface.
- G2: Deterministic policy engine, full rule set (budgets, caps, categories, vendor LCB floors, proof-tier requirements, duplicates, replay, rate limits, cooldowns, escalation thresholds, metadata redaction), evaluated against canonical SpendIntents.
- G3: **All enforcement modes live and demonstrable:** Advisory MCP for instant adoption, operator-authorized APP/x402 middleware for signed-payment protection, Broker Guard for APP-native flows, and UntchVault for hard on-chain enforcement.
- G4: Untch Bureau live — **vendor + buyer reliability**, sold standalone per-call and consumed internally; enforcement on lower-confidence scores; receipt-backed signals only.
- G5: Verification engine live across **proof tiers T0–T4** (schema, signed trace, source proof, TEE attestation adapter, evaluator/dispute confirmation), selected per policy.
- G6: Every decision receipted on X Layer (versioned UntchReceipts schema); score epochs and audit reports anchored; intents above policy threshold anchored in SpendIntentRegistry.
- G7: A2A audit line listed as three packaged SKUs (§16), producing anchored reports and dispute packets.
- G8: Operator dashboard (functional, undesigned): policies, intents, escalation inbox, ledger, vault, vendor + buyer scores, proof-tier distribution, disputes, reports.
- G9: Real revenue during the campaign across ≥3 SKUs; public sold-count and reviews on the listing, driven by an explicit review-acquisition loop (§17).
- G10: Dogfooding — Untch's own outbound spend runs through Untch and is publicly receipted.
- G11: Receipt-backed reputation **export** to ERC-8004-style registries where supported — interoperability target, not a dependency.

**Non-goals:**
- N1: Visual design system — owner assigns later; UI specs functional only.
- N2: Rebuilding settlement. OKX APP/Payment SDK/escrow move the money; we govern, verify, and receipt. A multiplier, not a replacement.
- N3: Trading features (Agent Trade Kit owns that lane).
- N4: Custody. **Untch's oracle key cannot withdraw funds or initiate arbitrary transfers. It can only authorize spends the user's vault already permits by policy, cap, token allowlist, nonce, and expiry. The owner can pause or withdraw without Untch.**
- N5: Token launch. · N6: Replacing Agentic Wallet (§6.4).

### 3.1 v1 Proof Levels (every claim ships with a proof object)

| Level | Meaning |
|---|---|
| **Live Listing Proof** | A2MCP listing live, paid, callable, with orders/reviews |
| **Mainnet Proof** | PolicyRegistry, SpendIntentRegistry, UntchReceipts, ≥1 UntchVault deployed + verified on X Layer |
| **Enforcement Proof** | A real agent payment approved, blocked, escalated, and receipted end-to-end |
| **Revenue Proof** | Paid tool calls + A2A audit orders visible in marketplace/accounting evidence |
| **Dogfood Proof** | Untch's own paid calls routed through Untch, publicly receipted |

## 4. Personas & jobs-to-be-done

| Persona | JTBD | Surfaces |
|---|---|---|
| **Agent operator** (solo builder / OPC founder, 1–10 agents) | "Give my agent a budget and rules; stop it wasting or getting drained; show me receipts and ROI." | Dashboard, vault, escalation inbox, reports |
| **The buyer agent** (software) | "Create a bounded intent; check this payment; verify the delivery; log the receipt." | MCP tools, middleware |
| **ASP vendor** | "Prove my revenue is clean; see my score and raise it; win confident buyers." | Vendor directory, score API, vendor analytics |
| **Auditor / judge / counterparty** | "Independently verify what this agent spent, why, and against what proof standard." | Public receipts explorer, anchored reports, §20 artifacts |

## 5. Product surfaces

- **S1 — Untch MCP Server** (A2MCP listing #1): pay-per-call tools (§11), settling via the x402 protocol through OKX's hosted facilitator (confirmed live at D0.1 — not a monolithic "Payment SDK"). **No seller-side MCP protocol wrapper required** — confirmed from OKX's APP Whitepaper v1.0: A2MCP sellers are plain priced HTTP services, the MCP tool wrapper lives on the buyer side. Deployed on non-geo-blocked infra (Railway) since the facilitator is unreachable from Nigerian/VPN egress (§25). Primary product + eligibility artifact.
- **S2 — A2A Audit Line** (listing #2): **Spend Leak Audit** · **Vendor Trust Report** · **Agent CFO Report** (§16), negotiated escrow, anchored deliverables + dispute packets.
- **S3 — Untch Guard** (`@untch/x402-guard`, open-source, MIT): **operator-authorized payment middleware** — the buyer agent routes paid HTTP/MCP calls through it; on a 402 challenge it validates recipient, amount, resource, nonce, expiry, policy, metadata safety, and duplicate state **before allowing the buyer agent to sign**. Distribution wedge + security story.
- **S4 — X Layer contracts:** `PolicyRegistry`, `SpendIntentRegistry`, `UntchReceipts`, `UntchVaultFactory/UntchVault` (§10).
- **S5 — Operator dashboard** (functional spec §15).
- **S6 — Public receipts explorer** (unauthenticated per-agent/per-vendor receipt pages).
- **S7 — Control channels:** Photon iMessage (Spectrum, primary) + Telegram + webhook + dashboard — approvals, alerts, and monitoring (§27); SMS/RCS fallback via Photon.
- **S8 — Broker Guard service** (Mode D runtime, §14).

## 6. System architecture

### 6.1 Component map

```
                        ┌────────────────────────────────────────────────┐
                        │                 OPERATOR PLANE                 │
                        │  Dashboard (S5) · Telegram bot · Webhooks      │
                        └───────▲──────────────────────────▲─────────────┘
                                │ escalations/approvals    │ reports
┌───────────────┐  MCP / x402  ┌┴──────────────────────────┴──┐
│  Buyer agent  │─────guard───▶│          UNTCH CORE           │
│ (any client)  │  broker(D)   │ ┌──────────┐ ┌─────────────┐ │
└──────┬────────┘              │ │ Intent + │ │ Trust       │ │
       │ pays vendors          │ │ Policy   │ │ Bureau      │ │
       ▼                       │ │ Engine   │ │ (2-sided)   │ │
┌───────────────┐              │ └────┬─────┘ └──────▲──────┘ │
│ OKX.AI market │  listings/   │      │              │        │
│ A2MCP · A2A   │  reputation  │ ┌────▼─────┐ ┌──────┴──────┐ │
│ escrow · APP  │─────────────▶│ │ Proof    │ │ Indexers    │ │
└──────┬────────┘   indexer    │ │ Engine   │ │ (chain+mkt) │ │
       │ settlement            │ │ T0–T4    │ └──────▲──────┘ │
       ▼                       │ └────┬─────┘        │        │
┌───────────────┐   receipts/  │ ┌────▼──────────────┴──────┐ │
│   X LAYER     │◀─────────────│ │ Ledger (Postgres+Redis)  │ │
│ PolicyRegistry│  sigs/reads  │ │ + Receipt Writer queue   │ │
│ IntentRegistry│              │ └──────────────────────────┘ │
│ UntchReceipts │              └───────────────────────────────┘
│ UntchVaults   │
└───────────────┘
```

### 6.2 Primary data flow

1. Operator creates Policy → ledger → `policyHash` anchored in `PolicyRegistry` → agent credentials issued.
2. (Mode C) Operator deploys UntchVault via factory, deposits USDT/USDG, binds policyId + oracle pubkey.
3. Before paying, the buyer agent (directly, via middleware, or via Broker Guard) produces a canonical **SpendIntent** (§8) — owner, buyer/worker agent IDs, token, maxAmount, taskHash, acceptanceHash, schemaHash, policyHash, deadline, nonce. Intents above the policy's `anchorIntentsAbove` threshold are registered on-chain.
4. Policy Engine evaluates intent against policy + ledger state + Untch Bureau **lower-confidence** scores → `Decision {APPROVE|BLOCK|ESCALATE}` + rule trace (§8.2).
5. APPROVE in Mode C → EIP-712 oracle signature (nonce, expiry, amount, recipient, intentHash); vault verifies on-chain. APPROVE in Mode D → Broker Guard forwards validated payment credentials for settlement.
6. ESCALATE → operator notified → approve/deny/timeout.
7. Delivery arrives → Proof Engine runs the required tier ladder (§13) → PASS/FAIL + evidence.
8. Receipt Writer batches versioned `ReceiptLogged` events to X Layer; explorer renders; reputation signals update **only from receipted outcomes**.
9. Indexers ingest chain + marketplace → Bureau recomputes both-side scores per epoch → `ScoreAnchored(root)`.
10. Reconciler produces rollups; A2A SKUs generate anchored reports/dispute packets on demand.

### 6.3 Trust boundaries
Buyer agents, vendor deliverables, and agent-supplied metadata are **untrusted input** (I3). Intent+Policy Engine and Proof Engine tiers T0–T2 are pure deterministic code (I1). The oracle signing key is the highest-value secret (§16). Contracts trust only: owner signatures, oracle signatures with nonce+expiry, registered writer keys, and their own storage.

### 6.4 Position within the OKX stack (native, not adversarial)

**Confirmed from primary source (APP Whitepaper v1.0, §3.1/§5.1/§5.2):** no seller-side MCP protocol wrapper is required for A2MCP. The Seller is "a priced HTTP service or tool the Buyer Agent consumes — often reached through an MCP tool on the Agent side"; the MCP tool lives on the *Buyer's* side, and "the payment rail here is plain HTTP." Untch's existing x402 routes (ping_untch, create_spend_intent, preflight_payment) are already listing-compatible on this dimension — nothing more to build here. The whitepaper separately notes embedding APP directly inside MCP tools/call for single-round-trip negotiation is flagged as "a natural area for further design work" — i.e. not current, not required.

- **APP (Agent Payments Protocol):** Untch is **APP-compatible spend governance** — it can run as a preflight MCP service, operator-authorized x402 middleware, a **broker-side policy module** (the APP broker role: accept seller payment request, mint payment ID, hold challenge state, verify buyer credentials against the stored challenge, recompute nonce, submit/forward for settlement, expose status polling — with our policy gate inline), or vault enforcement.
- **Agentic Wallet:** complements, never replaces. Agentic Wallet secures **key execution and transaction risk** (simulation, risk grading, TEE-held keys). Untch governs **commercial spend intent**: budgets, vendor trust, duplicate detection, delivery proof, receipts, accounting.
- **OKX.AI rails:** A2MCP for high-frequency machine calls (preflight, score, verify, redact, reconcile); A2A for negotiated audits with anchored methodology. Escrow release stays with OKX — we produce the machine-readable evidence that makes confirmation and arbitration programmable.

---

## 7. State machines (happy path + every failure state)

### 7.1 Intent creation & preflight

```
INTENT_DRAFT (fields per §8) ─ canonicalize (§9) ─▶ INTENT_CANONICAL(intentHash)
 ├─ missing/invalid required field ────────────────▶ REJECTED_MALFORMED (no charge)
 ├─ auth/apiKey invalid ───────────────────────────▶ REJECTED_UNAUTHENTICATED
 ├─ deadline in past / nonce reused ───────────────▶ REJECTED_STALE_INTENT
 └─ ok → (policy.anchorIntentsAbove met? register on-chain: PENDING)
     ▼
POLICY_LOOKUP
 ├─ policy not found/expired/paused ───────────────▶ BLOCKED_NO_ACTIVE_POLICY
 └─ found
     ▼
STATE_ASSEMBLY  (ledger windows, nonce store, bureau LCB scores, cooldown clocks)
 ├─ ledger unreachable ────────────────────────────▶ BLOCKED_FAIL_CLOSED (I2)
 ├─ score unavailable ─▶ per-policy: BLOCK | ESCALATE | USE_STALE(maxAgeH)
 └─ ok
     ▼
RULE_EVAL  (ordered, short-circuit, full trace §8.2)
 ├─ duplicate (taskHash+endpoint+paramsHash in TTL) ─▶ BLOCKED_DUPLICATE
 ├─ cooldown same-service not elapsed ─▶ BLOCKED_COOLDOWN
 ├─ replay/context mismatch vs challenge (§14 CBC) ─▶ BLOCKED_REPLAY
 ├─ recipient deny / not on allowlist(if set) ─▶ BLOCKED_RECIPIENT
 ├─ worker agentId blocked / not allowed ─▶ BLOCKED_AGENT
 ├─ category not allowed ─▶ BLOCKED_CATEGORY
 ├─ vendor LCB < floor ─▶ per-policy onBelowFloor: BLOCKED_VENDOR_RISK | ESCALATED_VENDOR_RISK
 ├─ amount > intent.maxAmount ─▶ BLOCKED_INTENT_BOUND
 ├─ per-call cap exceeded ─▶ ESCALATED or BLOCKED (per policy)
 ├─ budget window exceeded (daily/weekly/total) ─▶ BLOCKED_BUDGET
 ├─ rate limit exceeded ─▶ BLOCKED_RATE
 ├─ required proof tier unavailable from vendor ─▶ ESCALATED_PROOF_TIER
 ├─ amount > escalateAbove ─▶ ESCALATED_THRESHOLD
 └─ all pass ─▶ APPROVED
     ▼
DECISION_EMIT
 ├─ Mode C: sign EIP-712(intentHash,…) — key svc down ─▶ ESCALATED_SIGNER_DOWN
 ├─ Mode D: release validated credentials to settlement
 ├─ IntentRegistry status → APPROVED/BLOCKED; write DecisionRecord; queue receipt
 └─ return {decision, reasons[], ruleTrace[], sig?}
Concurrency: per-agent Redis lock serializes intents (no budget race).
Every terminal state, including every BLOCKED_*, queues a receipt — blocks are auditable value.
```

### 7.2 Escalation lifecycle (multi-channel)
```
CREATED ─▶ FAN_OUT (per policy.approvals.channels: iMessage(Photon) + Telegram + webhook + dashboard)
 │          each escalation carries a single-use approval code, TTL = escalation timeout
 ├─ all channels fail ─▶ retry ×3 backoff ─▶ NOTIFY_FAILED (inbox-visible; timeout clock runs)
 ├─ APPROVE received:
 │    ├─ iMessage poll vote / "APPROVE <code>" text / TG button / dashboard click
 │    ├─ sender handle ∉ operator's bound handles ─▶ IGNORED_UNBOUND (logged, alert)
 │    ├─ code invalid/expired/reused ─▶ IGNORED_BAD_CODE (logged)
 │    ├─ amount > policy.approvals.dualChannelAbove ∧ only one channel confirmed
 │    │        ─▶ AWAITING_SECOND_CHANNEL (distinct channel required)
 │    └─ valid ─▶ APPROVED ─▶ (Mode C sign / Mode D release) ─▶ agent retries intentRef
 ├─ DENY (any bound channel) ─▶ DENIED
 └─ timeout T (default 30 min, per-policy) ─▶ EXPIRED → default DENY (I2)
Idempotent by escalationId across channels (first valid decision wins; rest acked as already-resolved).
Approval after expiry rejected → re-submit intent. Every notification + inbound decision logged as a
notification receipt (channel, handle, latency) — the approval trail is part of the audit surface.
```

### 7.3 Delivery verification (proof tiers)
```
DELIVERY_RECEIVED (payloadHash, intentRef, proofs[])
 ├─ no acceptanceHash committed at intent ─▶ VERIFY_SKIPPED_UNCOMMITTED (logged; buyer-hygiene event)
 ▼
REQUIRED_TIER = policy.requireProofTier(amount)   // T0 default
T0 SCHEMA  (ajv schema, required fields, size bounds, regex/enum, exact-hash where deterministic)
 ├─ FAIL ─▶ VERIFY_FAILED{diffs[]} ─▶ recommend WITHHOLD; receipt(verify=FAIL,tier=0); vendor signal
T1 TRACE   (worker-signed {taskHash, inputHash, outputHash, toolCallHashes[], ts} vs registered key)
 ├─ sig invalid / key mismatch / stale ts ─▶ VERIFY_FAILED_BAD_TRACE
T2 SOURCE  (required sources present, content-hashes match, timestamps sane, URLs resolvable*)
 ├─ missing/unresolvable/hash-mismatch ─▶ VERIFY_FAILED_SOURCE      (*resolution best-effort, recorded)
T3 TEE     (attestation adapter: quote/cert chain valid, binds model id + request/response hashes)
 ├─ absent though required ─▶ VERIFY_FAILED_NO_ATTESTATION
 ├─ unknown format ─▶ ATTESTATION_UNVERIFIED (policy: fail | pass-with-flag)
T4 EVALUATOR (dispute packet → operator confirm or arbitration outcome ingested)
 └─ tiers ≤ REQUIRED all pass ─▶ VERIFY_PASSED{tier} ─▶ recommend RELEASE; receipt(verify=PASS,tier)
Receipts record adapter + result exactly — we never claim beyond what a tier proved.
```

### 7.4 Receipt writer (X Layer anchoring)
```
QUEUED ─▶ BATCHED (N receipts or T secs) ─▶ SUBMITTED(txHash)
 ├─ RPC/nonce error ─▶ RETRY ×5 backoff ─▶ DEGRADED_UNANCHORED (ledger authoritative; public lag banner; alarm)
 ├─ reverted ─▶ split batch, retry singles, alert
 └─ CONFIRMED (X Layer finality depth) ─▶ ANCHORED
Reorg ─▶ re-verify inclusion ─▶ resubmit if dropped. Ops gas wallet low ─▶ alarm at 20% runway.
```

### 7.5 UntchVault spend (Mode C, on-chain)
```
spend(recipient, amount, token, intentHash, oracleSig, nonce, expiry)
 ├─ paused ▶ revert VaultPaused          ├─ now>expiry ▶ revert SigExpired
 ├─ nonce used ▶ revert NonceReplay      ├─ recover≠oracle ▶ revert BadOracle
 ├─ amount>perTxCap ▶ revert CapExceeded ├─ epochSpent+amount>epochBudget ▶ revert BudgetExceeded
 ├─ token ∉ allowlist ▶ revert TokenNotAllowed
 ├─ policy requires anchored intent ∧ IntentRegistry[intentHash].status≠APPROVED ▶ revert IntentNotApproved
 └─ ok ▶ transfer; epochSpent+=amount; emit VaultSpend(...)
ownerWithdraw(): always available, no oracle (N4). setOracle/pause: owner-only.
Fallback (oracle offline): owner-set static allowlist keeps pre-approved micro-spends alive.
```

### 7.6 A2A audit fulfillment
```
TASK_ACCEPTED (scope negotiated on OKX.AI, funds in OKX escrow)
 ├─ data access fails (no ledger + address scan empty) ─▶ RENEGOTIATE or decline → OKX refund path
 ▼ INGEST (our ledger | imported x402 logs | X Layer scan) ─▶ ANALYZE (deterministic)
 ▶ NARRATE (LLM, sandboxed, labeled) ─▶ REPORT + DISPUTE_PACKETS ─▶ ANCHOR AuditAnchored(hash)
 ▶ DELIVER via OKX.AI ─▶ confirmation → release
 └─ buyer rejects ─▶ OKX arbitration; evidence = report + anchor + methodology appendix
```

### 7.7 Broker Guard (Mode D)
```
SELLER_PAYMENT_REQUEST ─▶ MINT paymentId ─▶ CHALLENGE_ISSUED (envelope stored: recipient, token,
  amount, resource, nonce, expiry, intentHash, policyId, metadataHash)
 ▼
BUYER_CREDENTIALS_RECEIVED
 ├─ credentials ≠ stored challenge (any CBC field) ─▶ REJECTED_BINDING (receipt)
 ├─ nonce recompute mismatch / reused ─▶ REJECTED_REPLAY
 ├─ policy eval (§7.1 RULE_EVAL inline) → BLOCKED_* / ESCALATED_* paths identical
 └─ APPROVED ─▶ FORWARD credentials for settlement ─▶ poll status ─▶ SETTLED (receipt) 
      ├─ settlement failure/timeout ─▶ SETTLE_FAILED → retry/void challenge → receipt
Guard never holds funds; it holds challenge state and gates credential forwarding.
```

---

## 8. Data model (Postgres source of truth; Redis for locks/nonces)

**operators** — id, auth_provider, wallets[], notif_prefs{webhook_url, telegram_chat_id, imessage_handle, imessage_verified, channel_caps{...}, alert_routing{...}}, bound_handle_verifications[], hygiene_snapshot_ref, created_at
**agents** — id, operator_id, label, agent_address, okx_agent_id?, key_fingerprint, status{ACTIVE|PAUSED|REVOKED}, mode{ADVISORY|GUARDED|BROKERED|VAULT}, vault_address?
**policies** — id (uint256-compatible), agent_id, version, status, policy_hash (keccak of canonical JSON §9), onchain_ref, rules JSONB:
```json
{
  "budgets": {"daily": 25, "weekly": 120, "total": 500, "token": "USDT"},
  "perCallCap": 1.0, "onPerCallCapExceeded": "BLOCK", "escalateAbove": 5.0, "escalationTimeoutMin": 30,
  "approvals": {"channels": ["imessage","telegram","dashboard"], "dualChannelAbove": 50.0,
                "channelCaps": {"imessage": 25.0, "telegram": 25.0}, "codeTTL": "escalationTimeout"},
  "categories": {"allow": ["market-data","security","research"], "deny": []},
  "recipients": {"allow": [], "deny": []},
  "vendors": {"allow": [], "deny": ["vendor_x"], "minScoreLCB": 55,
              "onBelowFloor": "ESCALATE", "onScoreUnavailable": "ESCALATE", "staleScoreMaxAgeH": 24},
  "agents":  {"allowWorkerIds": [], "denyWorkerIds": []},
  "duplicates": {"ttlMin": 60, "keys": ["taskHash","endpoint","paramsHash"]},
  "cooldowns": {"sameServiceMin": 5},
  "rateLimit": {"callsPerHour": 40},
  "proof": {"defaultTier": 0, "requireTierAbove": [{"amount": 3.0, "tier": 1}, {"amount": 10.0, "tier": 3}],
            "acceptedT3Adapters": ["tee-quote"], "onUnknownAttestation": "FAIL"},
  "anchorIntentsAbove": 2.0,
  "metadataRedaction": {"stripPatterns": ["email","phone","apiKey","name"], "hashOnly": true},
  "timeWindows": [{"days":"*","utc":"00:00-23:59"}],
  "expiry": "2026-12-31T00:00:00Z"
}
```
**spend_intents** — id, intent_hash, owner, buyer_agent_id, worker_agent_id?, vendor_id?, recipient_address, token, max_amount, amount_final?, category, pay_type{A2MCP|A2A}, endpoint/resource_url, params_hash, task_hash, acceptance_hash?, schema_hash?, policy_id, policy_version, policy_hash, deadline, nonce, mode, x402_challenge JSONB{recipient, token, amount, resource, nonce, expiry}, metadata_raw (encrypted, 30d purge), metadata_redacted, metadata_hash, onchain{registered?, txHash, status}, created_at
**decisions** — intent_id, outcome (terminal code per §7.1), reasons[], rule_trace JSONB (§8.2), oracle_sig?, sig_nonce?, sig_expiry?, decided_at, latency_ms
**escalations** — id, intent_id, status{PENDING|AWAITING_SECOND_CHANNEL|APPROVED|DENIED|EXPIRED|NOTIFY_FAILED}, approval_code_hash, code_expires_at, channel_log (fan-out + inbound events w/ handle + latency), resolved_by{channel, handle}?, resolved_at?
**deliveries** — intent_id, payload_hash, payload_ref?, received_at, tier_results JSONB [{tier, result, details/diffs}], final{VERIFY_PASSED(tier)|VERIFY_FAILED_*|SKIPPED_UNCOMMITTED|UNVERIFIED_FLAGGED}
**receipts** — id, schema_version, intent_id?, kind{DECISION|VERIFY|SCORE_ROOT|AUDIT|VAULT_SPEND|BROKER_SETTLE}, proof_tier?, batch_id, tx_hash?, block_no?, log_index?, status{QUEUED|SUBMITTED|CONFIRMED|RETRY|DEGRADED_UNANCHORED}
**vendors** — id, okx_listing_id, name, category, payout_addresses[], price_snapshot, first_seen, last_indexed
**score_snapshots** — subject{VENDOR|BUYER}, subject_id, epoch, score 0–100, uncertainty σ, **lcb** (score−z·σ), band, features JSONB, anchored_root?, computed_at
**ledger_entries** — append-only double-entry: agent_id, type{SPEND|FEE_UNTCH|BLOCK_SAVED|REFUND}, amount, token, counterparty, rollup keys (day/category/vendor). Corrections = reversal rows, never UPDATE.
**reports** — id, agent_id, period, kind{RECONCILE|LEAK_AUDIT|VENDOR_TRUST|CFO_REPORT}, artifact_refs[], dispute_packet_refs[], anchor_tx?
**replay_nonces** — (nonce, recipient, resource) unique + expiry — Redis with Postgres backstop
**api_keys / webhook_events / notification_log** — standard.

### 8.1 SpendIntent — the bounded object (canonical form)
```solidity
struct SpendIntent {
    address owner;          // operator wallet
    uint256 buyerAgentId;
    uint256 workerAgentId;  // 0 if A2MCP endpoint call
    address token;
    uint256 maxAmount;      // base units
    bytes32 taskHash;
    bytes32 acceptanceHash; // committed acceptance criteria (0x0 ⇒ hygiene event)
    bytes32 schemaHash;     // expected output schema
    bytes32 policyHash;
    uint256 deadline;       // unix
    uint256 nonce;
}
```
The agent cannot freestyle-send because a model said so — every payment is bounded by an intent, and the intentHash threads through decision, signature, vault spend, delivery, and receipt.

### 8.2 Decision Trace schema (concrete)
```json
{
  "decision": "BLOCKED_DUPLICATE",
  "intentHash": "0x…", "policyId": "12", "policyVersion": 3,
  "evaluatedAt": "2026-07-05T20:44:00Z",
  "rules": [
    {"rule": "policy.active", "result": "PASS", "observed": "ACTIVE"},
    {"rule": "budget.daily", "result": "PASS", "observed": "3.20", "limit": "25.00", "token": "USDT"},
    {"rule": "vendor.lcbFloor", "result": "PASS", "observed": 61, "limit": 55, "raw": 78, "sigma": 8.5},
    {"rule": "duplicate.taskHash_endpoint_paramsHash", "result": "FAIL",
     "priorIntentId": "pi_abc123", "ttlRemainingSec": 2140}
  ]
}
```

## 9. Canonicalization rules (all hashes)

All hashed JSON uses deterministic canonical JSON encoding (RFC 8785 JCS) before hashing. Addresses normalized to lowercase hex for hashing (EIP-55 for display). Token amounts normalized to integer base units (per-token decimals from the verified token list). Timestamps ISO-8601 UTC (`Z`). Resource URLs normalized (lowercase scheme/host, default ports stripped, path preserved, query params sorted) before `paramsHash`/`taskHash` computation. Struct hashing (SpendIntent, EIP-712 Spend) uses the declared Solidity ABI encoding. A `canonVersion` field accompanies every hash-bearing record. Without this section, hash mismatches become the #1 bug class — it ships as a tested shared library used by server, middleware, and contracts tests alike.

## 10. Smart contracts (Solidity · Foundry · X Layer testnet → mainnet, sources verified)

### 10.1 PolicyRegistry.sol
`policyId(uint256) ⇒ {owner, agent, policyHash(bytes32), status, expiry, version}`; owner nonce.
`registerPolicy / updatePolicy / pausePolicy / resumePolicy` (owner-gated). Events for each.
Purpose: immutable anchor that a committed ruleset governed a given agent at a given time.

### 10.2 SpendIntentRegistry.sol
`intentHash(bytes32) ⇒ {policyId(uint256), maxAmount, deadline, status}` · status ∈ {PENDING, APPROVED, BLOCKED, SETTLED, DISPUTED, EXPIRED}.
`registerIntent(SpendIntent calldata)` (agent/owner or authorized relayer) · `setStatus(intentHash, status)` (authorized writer/oracle) · expiry auto-derivable from deadline.
Anchoring is policy-controlled (`anchorIntentsAbove`) — a **control, not a scope cut**: micro A2MCP intents stay off-chain with intentHash carried in the receipt; larger intents get on-chain lifecycle that the vault can require (§7.5).

### 10.3 UntchReceipts.sol (versioned)
Events-only, batch writer, authorized writer set (rotatable; admin behind timelock).
```solidity
event ReceiptLogged(
    uint16  schemaVersion,
    bytes32 receiptId,
    uint256 indexed policyId,
    bytes32 policyHash,
    bytes32 indexed agentId,
    bytes32 indexed vendorId,
    uint256 amount,
    address token,
    bytes32 category,
    uint8   payType,        // A2MCP | A2A
    bytes32 intentHash,
    bytes32 taskHash,
    uint8   decision,
    uint8   verifyResult,
    uint8   proofTier,
    bytes32 metadataHash
);
event ScoreAnchored(bytes32 merkleRoot, uint64 epoch, uint8 subjectKind); // vendor | buyer
event AuditAnchored(bytes32 reportHash, bytes32 agentId, uint64 period);
```
Type discipline: `policyId` is `uint256` end-to-end (registry ⇄ receipts ⇄ API); `policyHash` is the separate `bytes32`. On-chain carries **hashes only** — taskHash, policyHash, intentHash, metadataHash, amounts, IDs, decisions, tier, timestamp. Prompts, outputs, and business payloads stay off-chain/encrypted between agents. *Public proof. Private work. Accountable payment.*

### 10.4 UntchVaultFactory.sol / UntchVault.sol
Factory `deployVault(owner, agent, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow[], requireAnchoredIntent)` — CREATE2 deterministic per agent.
Vault: `deposit`, `spend(...)` per §7.5 (EIP-712 domain `UntchVault(chainId, vault)`, struct `Spend(recipient, amount, token, intentHash, nonce, expiry)`), `ownerWithdraw` (unconditional), `setOracle`, `pause/unpause`, `setFallbackAllowlist(recipient, perTxMax)`.
Custody posture (verbatim product language): the oracle key **cannot** withdraw funds or initiate arbitrary transfers; it can only authorize spends the vault already permits by policy, cap, token allowlist, nonce, and expiry; the owner can pause or withdraw without Untch.
Invariant test matrix: no fund movement without (valid unexpired unused oracle sig ∧ caps hold ∧ [anchored-intent APPROVED if required]) ∨ owner withdraw ∨ fallback micro-spend; epoch accounting monotone; pause blocks spend, never withdraw.
Gas: ops wallet funds writer/oracle txs; low-balance alarm at 20% runway. **Anchoring cost is designed-to-be-minimal (events-only, batched); measured gas/receipt on X Layer will be published after deployment — no cost claims before measurement.**

## 11. MCP tool API (S1 — prices in USDT/call; every paid tool idempotent by client requestId)

| Tool | Price | Input | Output |
|---|---|---|---|
| `create_spend_intent` | bundled | intent fields (§8.1) | intentHash, canonical form, onchain status |
| `preflight_payment` | 0.05 | intentHash \| inline intent | decision, reasons[], ruleTrace (§8.2), sig? (C), receiptRef |
| `verify_delivery` | 0.10 | intentRef, payloadHash/ref, proofs[] | tier results, final, diffs[], receiptRef |
| `score_vendor` | 0.20 | vendorId \| listingId \| payout addr | score, σ, **lcb**, band, top features, epoch, root |
| `score_buyer` | 0.20 | agentId \| operator ref | hygiene score, σ, lcb, signals |
| `detect_duplicate` | 0.02 | taskHash, endpoint, paramsHash | duplicate?, priorIntentRef |
| `redact_payment_metadata` | 0.02 | metadata, policyId | redacted blob, metadataHash |
| `log_receipt` | bundled | intentRef | anchoring status, txHash on confirm |
| `generate_dispute_packet` | 0.50 | intentRef | evidence bundle (trace, tier results, receipts, timeline), anchor |
| `reconcile_agent_spend` | 0.25/day · 1.00/wk | agentId, period | report artifact + anchor tx |
| `create/update/pause_policy` | 0.50 / 0.10 | rules JSON | policyId, hash, tx |
| `get_ledger` | free (own data) | filters | entries, rollups |
Error envelope `{code, message, retryable, docsUrl}` · free tier: first 20 preflights per new agent · every paid call settles via the x402 protocol through OKX's hosted facilitator (confirmed live, §29 D0.1) — our revenue is itself visible marketplace revenue.

## 12. Untch Bureau — Vendor + Buyer Reliability (two-sided)

Deterministic weighted feature model, no LLM (I1). Score 0–100 with per-score uncertainty σ; **enforcement always uses the lower-confidence bound LCB = score − z·σ** (z=1.28 default). Cold start: category-baseline prior, wide σ surfaced — e.g. raw 78 / σ high → LCB 58 vs floor 65 ⇒ per-policy `onBelowFloor` (default ESCALATE, not silent block).

**Vendor features (weights):** track_record_depth 0.20 (log-scaled receipted orders) · rating_quality 0.20 (Bayesian-shrunk, prior=category mean, k=20) · delivery_consistency 0.20 (tier-pass rate on Untch-observed deliveries) · dispute_signal 0.15 (withhold/arbitration per 100 receipted orders) · wallet_operational_profile 0.10 (**public wallet-risk indicators where available, payout-address age and continuity, interaction diversity, abnormal self-dealing clusters, operational consistency**) · price_sanity 0.075 · claims_consistency 0.075 (listing claims vs observed latency/schema honesty).

**Receipt-backed reputation signals (the only inputs that move reputation):** paid task completed · output matched schema · delivery before deadline · no duplicate billing · refund/dispute rate · response latency · total verified revenue · repeat-buyer count · policy-violation count. Star ratings without receipts are display-only context, never enforcement input — *reputation upgrades only from receipt-backed work.*

**Buyer hygiene (scored symmetrically):** pays without committed acceptance criteria · late escalation resolution · dispute-after-vague-spec rate · ignores verification results · unsafe metadata attempts · out-of-policy attempt rate. Hygiene never blocks a buyer's own spend (their money); it annotates counterparty risk for vendors, prices future assurance products, and feeds CFO-report recommendations. Long-term moat: agent marketplaces need **both** sides scored.

Anti-gaming: wallet-cluster self-dealing discounts on receipted volume; review-velocity anomaly damping; our own listings scored by the same public model (I5). Epoch 6h; snapshots merkle-rooted → `ScoreAnchored(root, epoch, subjectKind)`. Methodology page public.

**Data-source fallback (first-class, not an open question):** if marketplace listing/review data is unavailable or restricted, the Bureau falls back to internal receipt-backed data, public X Layer activity, payout-address continuity, and Untch-observed delivery history; feature weights renormalize and σ increases (LCB tightens enforcement automatically).

**Disclaimer (shipped in product + docs):** scores are operational confidence signals, not legal, financial, or criminal-risk determinations. Vendor appeal/correction flow included.

**ERC-8004 posture:** Untch can **export** receipt-backed feedback (success rate, response time, verified revenue, feedback hash/URI-style tags) to ERC-8004-compatible registries where supported. Interoperability target, not a dependency — early raw registry reputation is shallow and Sybil-distortable, which is exactly why our enforcement input is receipts, not registry stars.

## 13. Proof Engine — progressive proof tiers

| Tier | Name | Proves | Mechanism |
|---|---|---|---|
| **T0** | Schema Proof | Output matches required JSON/schema, fields, bounds | ajv + constraint checks; exact-hash for deterministic outputs |
| **T1** | Trace Proof | Worker signed input/output/tool-call hashes | worker key (registered at index time) signs {taskHash, inputHash, outputHash, toolCallHashes[], ts}; 20-line vendor snippet published |
| **T2** | Source Proof | Required sources present with hashes + timestamps | source manifest validation; best-effort resolution recorded |
| **T3** | TEE Proof | Execution attested by TEE | adapter registry verifies quote/cert chains binding model id + request/response hashes; unknown formats ⇒ `ATTESTATION_UNVERIFIED`, policy decides |
| **T4** | Evaluator/Dispute Proof | Semantic quality confirmed | dispute packet → operator confirmation or arbitration outcome ingested |

Policies map amounts → required tier (`proof.requireTierAbove`). Receipts record the exact tier achieved. Language discipline everywhere: *progressive proof levels* — schema, signed traces, source hashes, receipt-backed reputation today; TEE attestation as an adapter module; no ZK claims anywhere. **Untch does not trust agent text. It trusts bounded intents, signed receipts, and verifiable delivery traces.**

## 14. Enforcement modes (all live and demonstrable)

| Mode | What it is | Strength |
|---|---|---|
| **A — Advisory MCP** | Operator adds our MCP server + published system-prompt clause ("before any payment, create an intent and call preflight; obey the decision") | Works with any agent framework in minutes; honest weakness: a misbehaving agent can skip — caught by reconciliation, cured by B/C/D |
| **B — Untch Guard** (`@untch/x402-guard`, operator-authorized APP/x402 middleware) | Buyer agent routes paid HTTP/MCP calls through the middleware; on a 402 challenge it runs the **Challenge Binding Check** and preflight **before allowing the buyer agent to sign** EIP-3009; BLOCK ⇒ structured refusal; ESCALATE ⇒ held with poll handle | Secures common paid-API flows; strips PII pre-signature; open-source wedge |
| **C — Untch Vault** | Agent's spendable funds live in its vault; only oracle-signed approvals within on-chain caps (and, if required, APPROVED anchored intents) move funds | Preflight becomes physics; owner withdraw unconditional |
| **D — Untch Broker Guard** | For APP-compatible flows where the broker role is configurable/self-hosted: Untch acts as the broker-side policy guard — holds challenge state, verifies buyer credentials against the original payment request, recomputes nonce, and only forwards valid payment credentials for settlement after policy approval (§7.7) | Native to OKX APP architecture; zero agent-side integration |

**Challenge Binding Check (named first-class primitive):** before any signature or credential forwarding, validate **recipient · token · amount · resource URL · endpoint/method · nonce · expiry · taskHash/intentHash · policyId · metadataHash** exactly against the stored challenge. All match ⇒ proceed; any mismatch ⇒ terminal BLOCKED_REPLAY/REJECTED_BINDING receipt. This is the direct answer to replay/context-swap risk.

Adoption ladder: A (minutes) → B (one import) → C (one deploy + deposit) → D (infrastructure-native). All four demoed.

## 15. Dashboard — functional requirements (no design system)

Auth (OKX Wallet priority) + API-key issuance/rotation · policy builder (guided + raw JSON, version diff, one-click pause, on-chain status) · **intent stream** with decision chips and rule-trace expander · escalation inbox (countdown, approve/deny, audit trail; Telegram/webhook config) · ledger explorer (filters, receipt anchor links, CSV/JSON export) · vault panel (deploy, deposit, withdraw, pause, oracle status, epoch gauge, nonce history) · vendor + buyer directories (score, σ, LCB, band, feature breakdown, "why this score", methodology link, appeal flow) · **proof-tier distribution** widget · disputes view (packets, outcomes) · top worker agents · reports (generate/download; anchor tx) · **savings widget** (blocked-waste USDT — the screenshot artifact) · public explorer (S6). The dashboard is not the product; it is the proof surface.

## 16. Security & threat model

**Invariants:**
- **I1** — No LLM output in any money decision path; LLM = narrative only, sandboxed, no tools.
- **I2** — Fail closed: any dependency failure in preflight ⇒ BLOCK or ESCALATE, never silent APPROVE.
- **I3** — Deliverables and agent-supplied metadata are data, never instructions.
- **I4** — Funds sovereignty: oracle key cannot withdraw or arbitrary-transfer; owner pause/withdraw needs nothing from us.
- **I5** — Symmetry: our own spend is policy-checked and publicly receipted; our listings scored by the public model.

| Threat | Vector | Mitigation |
|---|---|---|
| Replay / context-swap | reused or altered 402/APP challenge | Challenge Binding Check (§14) + nonce store (Redis+PG) + sig expiry ≤10min + broker nonce recompute |
| Oracle key theft | server compromise | KMS/encrypted keystore, per-sig nonce+expiry, vault caps bound damage, owner pause + rotation runbook |
| Prompt injection via deliverable | payload contains instructions | I3; tiers T0–T2 non-LLM; report LLM sandboxed, no tools |
| Budget race | concurrent intents | per-agent lock; vault epoch accounting as on-chain backstop |
| Score gaming | wash-traded sold counts, review floods | receipt-backed-only signals, self-dealing cluster discounts, velocity damping, σ surfacing |
| PII leakage | payment metadata | redaction default-on in middleware; only metadataHash on-chain; raw purged 30d |
| Defamation exposure | vendor disputes a score | factual receipted features only, published methodology, disclaimer, appeal flow |
| Fee-skim suspicion | "who audits the auditor" | I5 dogfooding + anchored score roots + public methodology |
| DoS on preflight | spam | calls cost money + per-key rate limits |
| Writer key abuse | forged receipts | writer signs only into event log (no funds); rotatable; cross-checkable vs ledger API |
| RPC/chain outage | anchoring stalls | DEGRADED_UNANCHORED: ledger authoritative, public lag banner, backfill |
| Vault bug | fund loss | smallest surface, invariant/fuzz tests, caps bound blast radius, unconditional owner withdraw, deposit caps during campaign |
| OKX facilitator unreachable from Nigerian IPs + commercial VPN ranges (confirmed at network layer, D0.1) | Any service calling OKX endpoints directly (seller, Mode D Broker Guard, future indexers hitting OKX APIs) can't run from local Lagos dev or over a consumer VPN | Deploy those components to Railway (already the default compute target) whose egress reaches OKX cleanly; keep buyer-side signing and local dev local, since that path only needs the seller's own URL + public rpc.xlayer.tech, both reachable from Lagos |
| Approval-channel compromise | SIM-swap / iCloud takeover / stolen device approves spends | handle binding + single-use codes (TTL) + per-channel amount caps + `dualChannelAbove` two-distinct-channel rule + every inbound decision receipted |
| Approval spoofing / replay | forged or replayed poll-vote / text approval | credentialed Spectrum stream, bound-handle match, one redemption per code across all channels, idempotent escalationId, unbound-handle alerts |

---

## 17. Pricing, revenue & the review-acquisition loop

**A2MCP SKUs:** preflight 0.05 · verify 0.10 · vendor/buyer score 0.20 · dispute packet 0.50 · redact 0.02 · duplicate 0.02 · policy create 0.50 · reconcile 0.25/day, 1.00/wk. Free tier: 20 preflights per new agent.
**A2A SKUs (listing #2):**

| SKU | Price | Deliverable |
|---|---|---|
| **Spend Leak Audit** | 5–10 USDT | duplicate calls, waste, high-risk vendors, unchecked payments |
| **Vendor Trust Report** | 5–15 USDT | scores for an agent's vendor set + risk drivers, anchored |
| **Agent CFO Report** | 10–20 USDT | period spend, ROI, blocked waste, hygiene, recommendations, anchored |

**Unit economics:** marginal cost per paid call ≈ compute + amortized anchoring gas; batched events-only logging is designed to keep anchoring cost minimal — **measured gas/receipt published post-deployment, no cost claims before measurement.**
**Review-acquisition loop (Revenue Rocket is revenue + orders + positive reviews — engineer all three):** 20 free preflights → invite builders to run the demo policy → first paid reconcile report → in-product review ask on OKX.AI after a successful report → public receipts-explorer link in every report → "blocked waste" screenshot prompts. No hoping for organic traffic.
**Startup pricing (post-campaign):** Starter $19/mo · Pro $99/mo (10 agents, middleware priority, vault) · Vendor Analytics $49/mo · Enterprise custom (SLA, dedicated oracle).
**Long-run ladder:** control plane → receipt-backed financial graph (vendor reliability + buyer hygiene + spend histories + revenue quality) → underwriting products (payment assurance, advance-on-escrow, insurance). The Experian→lending sequence, unlocked by exactly the ledger this product accumulates.

## 18. Metrics & instrumentation

Primary: paid tool calls/day · distinct paying agents · qualified revenue by SKU · listing orders + review count. Product health: block rate & blocked-waste USDT · escalation median resolution · tier-pass rates and **proof-tier distribution** · preflight p95 <300ms · receipts anchored vs lag · vault TVL + spend count · middleware npm installs · score API distinct subjects · buyer-hygiene coverage. Control-channel health: approval median latency per channel · notification delivery success rate · dual-channel completion time. All derivable from ledger + chain + notification receipts — the dashboard is the analytics.

## 19. Eligibility & rules compliance map

| Verified rule | Our artifact |
|---|---|
| ASP must pass OKX internal review and go live, else submission invalid | S1 listed immediately after Payment SDK hello-world passes; S2 as second listing; listing copy framed on a clear real-world use case ("accounts payable for autonomous agents") |
| Window Jul 3 – Jul 17 23:59 UTC; Google form with ASP details + X post link | Form package prepared at listing time; **submit early** — parallel review means early listings sell during the window |
| X post with #OKXAI: introduce ASP, use case, clear demo/walkthrough | §20 judge demo, 90-second cut + thread + explorer links |
| Judging: product quality, use case strength, marketplace fit, innovation, reliability, long-term potential, social traction | Reliability = I1/I2 demonstrable · marketplace fit = §6.4 native positioning, we increase OKX.AI order volume by construction · long-term = §17 ladder |

Compliance posture: no custody (I4 language verbatim in docs), no trading surface, PII stripped by default, fees transparent on-listing, score disclaimer shipped. Where a rule is ambiguous it sits in §23, never in an assumption.

## 20. Judge Demo — the 90-second proof

1. Policy created and anchored (PolicyRegistry tx shown).
2. Agent creates a bounded SpendIntent and attempts a valid paid A2MCP call → **approved** (rule trace flashes).
3. Agent repeats the identical call → **blocked as duplicate** (savings widget ticks).
4. Agent tries an 8 USDT research hire above threshold → **escalated**.
5. Operator approves from a blue bubble — Photon iMessage poll tap (Telegram fallback shown) — and the approval signs.
6. Worker returns output with schema + signed trace → **T1 verified**.
7. Receipt appears on the public X Layer explorer (live click-through).
8. Dashboard close: spend total, waste blocked, receipts anchored — **and Untch's own revenue earned during the demo, itself receipted (dogfood).**

Target read: 20 USDT budget · ~3.20 spent · ~1.10 waste blocked · 1 escalation approved · receipt-backed trust events visible. Long cut for the form; 90-second cut for the #OKXAI post. *"I gave an AI agent 20 USDT and told it to research three assets. Watch Untch stop it wasting money."*

## 21. Independent Verification Artifacts (judges shouldn't need to trust the video)

OKX.AI listing URL(s) · public paid-order count + reviews · #OKXAI participation post · X Layer contract addresses with verified sources · public receipts explorer · sample policy hash · sample blocked-duplicate receipt · sample escalated payment · sample verified delivery receipt (tier shown) · npm package for the middleware · public Untch Bureau methodology page · demo agent API key in **capped sandbox mode** so a judge can trigger an approve/block themselves · escalation approved via iMessage poll on camera (notification receipt shown).

## 22. Build order (dependency-sequenced; owner sets the calendar)

0. **Execute the Day 0 gate (§29)** — D0.1 (x402/facilitator hello-world, **PASS**) through D0.9; hard gate on D0.1/D0.3/D0.4/D0.5 before any feature work. D0.3's remaining item is ops-wallet funding on **mainnet** (corrected from an earlier testnet assumption — no testnet facilitator exists).
1. **Canonicalization lib** (§9) + **SpendIntent** types — shared by everything.
2. **Policy engine core** — pure TS, exhaustive terminal-state tests (§7.1) + concurrency lock.
3. **MCP server (S1)** + SDK integration + tools → **submit listing + hackathon form immediately.**
4. **Contracts** — Registry, IntentRegistry, UntchReceipts, VaultFactory/Vault through the full §28 pipeline (statics → unit/fuzz/invariant → differentials → fork → soak → checklist) → mainnet, verify sources; publish measured gas.
5. **Receipt writer + indexers** → Untch Bureau v1 (two-sided, LCB) live.
6. **x402-guard middleware (S3)** — npm, MIT; Challenge Binding Check test vectors.
7. **Proof Engine** — T0/T1/T2 full, T3 adapter registry, T4 dispute packets.
8. **Broker Guard (Mode D)** — against APP docs; if broker role proves non-self-hostable, demonstrate against our reference APP flow and flag precisely.
9. **Control channels** (Photon iMessage poll approvals + Telegram + webhook + inbox, §27) · **Dashboard + explorer** · **A2A SKUs + listing #2**.
10. **Demo choreography (§20)** + review-acquisition loop live + daily build-in-public posts. Dogfooding on from step 3.
Stack: TypeScript/Node (Fastify) · Postgres + Redis + BullMQ · viem · Foundry · Next.js (undesigned) · Telegram Bot API.

## 23. Open questions (flagged, not guessed)

1. **Txns/volume contest** — owner to supply the link; receipt-batching cadence and event shape finalize for double-eligibility only after reading its actual rules.
2. **Track stacking** — can one ASP win multiple tracks? Ask in X Layer Builder Hub TG before allocating polish-hours. (Track names adopted from the current official page — Best Product, Creative Genius, Revenue Rocket, Finance Copilot, Software Utility, Lifestyle Companion, Artistic Excellence, Social Buzz — re-verify once at form submission.)
3. **OKX Payment SDK specifics** — **RESOLVED at D0.1.** There is no monolithic SDK: it's the x402 protocol via OKX's hosted facilitator, endpoint `https://web3.okx.com/api/v6/pay/x402/*` (an earlier pass had the stale `/facilitator/...` prefix). Custody is self-custody — buyer signs an EIP-3009 authorization with its own key; the seller's OKX HMAC triple authenticates the seller's verify/settle calls only, never moves funds itself. Settlement token confirmed live: USDT0. Real settlement proof: tx `0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc`, independently verified on rpc.xlayer.tech (not taken on the facilitator's word) — receipt status 0x1, USDT0 Transfer, broadcast by OKX's own facilitator relayer. §11 mechanics confirmed compatible; no changes needed to the tool table itself.
4. **APP broker-role self-hosting** — *resolved at D0.9*; determines Mode D's demo form (§22.8).
4a. **Escrow operational liveness (new, flagged before S2 work starts).** The APP Whitepaper v1.0 describes `escrow` as a fully-specified intent backed by an audited on-chain custody contract — reads as complete. A separate, more recently dated OKX marketing page lists payment types and tags escrow specifically "(coming soon)" while other types read as already shipped. Everything proven real so far (D0.1, Step-2's `$0.05` `preflight_payment` settlement) used `charge` — direct signed authorization, no custody contract — exactly matching how the whitepaper says `charge` settles, and distinct from how `escrow` is described as settling. S2 (the Untch Audit Line) is designed entirely around escrow (§5, §7.6, §16: funds in OKX escrow → confirmation → release). **Do not build S2 assuming escrow works.** Resolve with one direct test — attempt a single real minimal escrow-shaped payment against OKX's actual Broker — before any S2 implementation begins. If escrow isn't live yet, S2 either waits or gets reframed around `charge`/`upto` for a interim version.
5. **USDG contract address + decimals on X Layer** — *resolved at D0.3* from the official token list before vault `tokenAllow` is set.
6. **Marketplace data access** — public endpoint vs HTML; respect ToS. Bureau fallback is already first-class (§12), so this only affects feature richness.
7. **Photon specifics to capture at D0.6:** subscription terms/pricing, provisioned sending line, event-auth/signature scheme, rate limits, poll + mini-app availability on our plan. Channels are policy-config, so any gap degrades to Telegram-primary without code forks.
8. **Non-load-bearing claims to verify before use:** XMTP as A2A transport, `npx skills add okx/onchainos-skills`, any "gas-free X Layer" implication for our own contract writes. Each is an enhancement toggle if confirmed, never a dependency.

## 24. Track positioning (official names)

| Track | Case |
|---|---|
| **Best Product** | Complete control loop live: intent → policy → enforce → verify → receipt → report, with real orders |
| **Software Utility** | Infrastructure every ASP and buyer agent can call today; open-source middleware |
| **Finance Copilot** | Budgets, approvals, receipts, reconciliation, audits, ROI — the finance stack for agent operators |
| **Revenue Rocket** | Micro-priced high-frequency SKUs + packaged A2A audits; engineered review loop; public sold-counts |
| **Social Buzz** | "I gave my agent 20 USDT and it couldn't rug me" + blocked-waste screenshots + public receipt pages |
| **Creative Genius** | A new financial primitive for autonomous software — bounded intents + proof-gated receipts — not another chatbot |
Not chased: Lifestyle Companion, Artistic Excellence.
One-liner bank: *"Agents can earn on OKX.AI. Untch makes them safe to fund."* · *"Every agent payment: bounded before, checked at signing, verified on delivery, receipted forever."* · *"OKX.AI lets agents do business. Untch makes that business controllable."* · *"The model never touches the money."* (brand tagline — everywhere: README, listing, demo, X post, dashboard, contract docs.)

## 25. Risks & mitigations

| Risk | Mitigation |
|---|---|
| OKX listing review rejects a meta-service or lags | Two listings double pass probability; submit day-one; marketplace-meta precedent exists; TG builder-hub escalation |
| Payment SDK diverges from assumptions | **Resolved** — D0.1 proved the real mechanism (x402 + hosted facilitator, self-custody, endpoint confirmed); build task #0 served its purpose |
| Thin marketplace order volume during window | Modes A/B/D govern *any* APP/x402/MCP spend, not only OKX.AI purchases — volume independent of marketplace GMV |
| Vault bug = fund loss | Minimal surface, invariant/fuzz tests, caps, unconditional owner withdraw, pause, campaign deposit caps |
| Score defamation complaints | Receipt-backed factual features, σ surfacing, disclaimer, methodology page, appeal flow |
| Solo-builder 24/7 escalations | Safe timeout defaults (deny), fallback allowlist, status page |
| Broker role not self-hostable | Mode D demoed on reference APP flow, flagged precisely; Modes A/B/C unaffected |
| Copycats during campaign | Moat = anchored receipt history + two-sided score data + versioned public receipt standard + first real sold-count |

## 26. Definition of done (v1)

All five §3.1 proof levels achieved · two listings live with real paid orders and reviews · all four enforcement modes demonstrable on mainnet · ≥1 external operator (not us) with a funded policy · public explorer resolving real X Layer txs · blocked-waste counter > 0 from genuine traffic · dispute packet generated for a real held payment · form + #OKXAI post submitted early · zero invariant violations (I1–I5) in logs · measured gas/receipt published.

---

## 27. Control channels — Photon iMessage + Telegram (notifications, approvals, monitoring)

**Stack choice:** Photon's **Spectrum** — an open-source (MIT) TypeScript multi-channel agent framework connecting to Photon's managed infrastructure over a persistent gRPC stream: no Mac, no local relay, no webhook to maintain, with automatic SMS/RCS fallback when iMessage delivery isn't possible. Critically for Untch, channel failover is native: explicit routing like `imessage().fallback(telegram())` collapses our channel-failover requirement into the transport layer. Sub-second delivery on Photon's edge network. This replaces a bespoke Telegram-only bot with one notify service speaking every channel.

**Modes available (decided at D0.6):**
- *Production:* Spectrum / Photon remote — requires an active Photon subscription; server URL + API key come from the Photon dashboard. Runs anywhere (Railway-compatible — our stack), which local mode cannot.
- *Dev fallback:* `@photon-ai/imessage-kit` local mode — macOS only, reads chat.db, sends via AppleScript, needs Full Disk Access; fine for development, not deployable on Linux compute.
- *Deep-feature server:* `@photon-ai/advanced-imessage-kit` (HTTP + Socket.IO to a Photon iMessage server) if we need capabilities beyond Spectrum's surface.

**Approval mechanics over iMessage (judge-proofed — claims scoped to what D0.6 confirms):**
1. **Text-code approvals (judge-safe baseline):** `APPROVE <code>` / `DENY <code>` replies to the escalation message. This is the claim we pitch unconditionally — it needs nothing beyond basic send/receive.
2. **Poll approvals (enhanced path, confirmed at D0.6):** each escalation sent as a native iMessage poll — "Approve 8.00 USDT → research ASP? [Approve <code>] [Deny]" — with vote events carrying the voting participant's handle, so the approval is a structured event rather than parsed text. Older Photon poll-vote docs exist under a now-deprecated kit that points to Spectrum; Spectrum's own poll-vote event behavior on our plan is unverified until D0.6 confirms it. We do not pitch poll support as a claim until that check passes.
3. **Mini-app card (stretch, demo gold, same D0.6 gate):** Photon supports agentic mini apps — interactive UI rendered natively inside the iMessage thread; an approval card with rule-trace summary + Approve/Deny buttons is the strongest possible demo beat ("govern your agent's money from a blue bubble").

**Security model for chat-channel approvals:**
- **Binding tuple (not handle-only):** channel + provider + spaceId/conversation ID (where available) + sender handle + verified operator wallet + last-verified timestamp — verified at onboarding via code roundtrip. Handle-only binding is insufficient: Photon documents shared-line behavior on lower tiers and dedicated numbers on paid tiers, so a stable space/conversation identifier matters as much as the number itself. Decisions failing any part of the tuple are ignored and alerted (see Control-channel authority boundary below).
- **Single-use codes:** every escalation embeds a code, TTL = escalation timeout, one redemption across all channels.
- **Dual-channel rule:** `approvals.dualChannelAbove` — amounts above the threshold require confirmation on two distinct channels (e.g., iMessage poll + dashboard), mitigating SIM-swap / iCloud-compromise / single-device theft.
- **Channel amount caps:** per-channel max approval amount (e.g., iMessage alone can clear ≤ 25 USDT; above that, dashboard required).
- **Event authenticity:** Spectrum stream is credentialed (API key / authenticated gRPC session); we additionally match the inbound handle against the binding and log every event as a notification receipt. Exact event-auth/signature scheme captured at D0.6 — not assumed.

**Monitoring & alert catalog (same channels, severity-routed):**
escalation pending (+ reminder at T/2) · budget 80% / 100% consumed · duplicate-block spike · vendor LCB drop below any active floor · receipt anchoring lag (DEGRADED_UNANCHORED) · oracle signer health / key rotation events · vault low balance & large withdraw · ops-gas wallet < 20% runway · OKX listing review status change · daily digest (spend, blocked waste, revenue earned, receipts anchored). Severity routing: INFO → digest only; WARN → iMessage; CRIT → iMessage + Telegram + webhook, repeat until acked. Every alert is itself receipted in the notification log (dogfood: the control plane is monitored like the money).

### Control-channel authority boundary

Photon, Telegram, webhook, and dashboard **do not make money decisions.** They only transport operator responses for escalation states the deterministic policy engine already created. A channel approval is valid only if, at the moment it's received: (1) the intent is still active, (2) the policy allows escalation, (3) the sender's full binding tuple matches (channel + provider + spaceId/conversation ID where available + sender handle + verified operator wallet + last-verified timestamp — not handle alone, since shared-line/line-pool behavior on lower Photon tiers means sender/space stability matters more than the blue bubble itself), (4) the single-use code is valid and unexpired, (5) channel caps are respected, (6) dual-channel rules pass where required, and (7) the final Vault/Broker-Guard path still independently validates nonce, expiry, policy, amount, and recipient. Any failed check ⇒ the approval is **ignored and receipted as a failed control event** — never silently dropped, never silently honored.

Hierarchy, always: **Policy decides → Photon/Telegram/dashboard notify and capture → Vault/Broker Guard enforces → X Layer receipts prove.** Demo line: *"The agent asked to spend 8 USDT. Untch escalated it. I approved from iMessage. The model still never touched the money."*

### Approver model — one operator, multiple channels (v1); N approvers per policy (v2, schema-ready now)

**Confirmed for v1:** a policy has exactly one authorized approver — one operator, reachable through however many channels are bound to them (Telegram, Discord, Slack; Photon later). Any bound channel can approve that operator's own escalations; the operator is one identity with multiple reachable surfaces, not multiple people.

**Why this isn't the whole story:** §17's Enterprise tier already promises "teams giving agents real budgets" — a real, priced target segment, not a hypothetical. A team needs more than one person able to approve the same policy's escalations (a finance lead, an ops lead, either able to act), which "one operator, many channels" cannot express no matter how many channels that one operator binds.

**The two are not competing architectures.** Team-of-N approvers is a strict generalization of one-operator-many-channels (which is team-of-1). The only real design fork: does a policy's authorization model allow more than one approver, or does it hardcode exactly one? Get this right now while it's cheap (one join table, e.g. `policy_approvers(policy_id, operator_id)`, always exactly one row today) rather than later, once dashboards and other features have baked in a single-approver assumption that would need a real migration to undo.

**v2, named explicitly, not vague:** multiple authorized approvers per policy, each with their own channel bindings, any one of whom can approve — ships when Enterprise customers actually need it, not before. The schema should already support it the day it's asked for; the UI/policy config to actually add a second approver is the only new work, not the underlying model.

**Dashboard additions (§15):** channel bindings + verification status, per-channel caps, alert routing matrix, notification receipts view.

---

## 28. Contract audit & test pipeline (pre-mainnet gate)

Applies to `PolicyRegistry`, `SpendIntentRegistry`, `UntchReceipts`, `UntchVaultFactory`, `UntchVault`. Nothing touches X Layer mainnet until every gate below is green.

**Compiler & style:** solc pinned in `foundry.toml` (0.8.2x, exact patch recorded), optimizer settings + via-ir decision documented and constant across test/deploy; warnings-as-errors; solhint config committed.

**Static analysis (CI-gated, run per PR):**
- **Slither** — fail CI on High/Medium; accepted findings live in a committed `slither.triage.json` with written justification each.
- **Aderyn** (Cyfrin) — full report committed per release tag; High findings block.
- Cross-check: any finding one tool raises and the other doesn't gets a written disposition — no silent disagreement.

**Test battery (Foundry):**
1. **Unit** — every function; every revert path in §7.5 enumerated as a negative test (VaultPaused, SigExpired, NonceReplay, BadOracle, CapExceeded, BudgetExceeded, TokenNotAllowed, IntentNotApproved).
2. **Fuzz** — per-function property fuzz over amounts, nonces, timestamps, tokens, epoch boundaries (epoch-rollover edge explicitly).
3. **Invariant / stateful fuzz** — handler-based, encoding §10.4 verbatim: funds never move without (valid unexpired unused oracle sig ∧ caps hold ∧ anchored-intent-APPROVED when required) ∨ ownerWithdraw ∨ fallback micro-spend; epochSpent monotone within epoch and resets exactly on rollover; pause blocks spend, never withdraw; nonce single-use forever.
4. **Signature differential** — EIP-712 `Spend` signed with viem must recover on-chain; adversarial vectors: wrong chainId, wrong verifying contract, mutated field, expired, reused nonce, sig malleability (s > n/2).
5. **Canonicalization differential** — JS RFC-8785 canonical-JSON hashing vs Solidity `abi.encode` SpendIntent hashing on a shared fixture corpus (graduates from Day 0 spike D0.5 into permanent CI).
6. **Fork / integration** — X Layer testnet fork: full lifecycle approve → vault spend → receipt batch → confirm; failure injection: RPC drop mid-batch must land in DEGRADED_UNANCHORED, never silent loss.
7. **Gas** — `forge snapshot` diffed per PR; measured **gas/receipt** and gas/vault-spend published (fulfills the §17 measurement promise).
8. **Coverage** — `forge coverage`: **100% branch on UntchVault**, ≥95% branch on the other contracts; coverage report committed.
9. **Mutation testing (stretch)** — Gambit/vertigo-rs pass on UntchVault; surviving mutants get written dispositions.
10. **Symbolic (stretch)** — Halmos over `spend()` preconditions.

**Testnet soak:** ≥50 full real cycles on X Layer testnet across all decision outcomes (approve / block / escalate-approve / escalate-timeout / verify-fail-withhold), plus a pause drill and an oracle-key rotation drill executed end-to-end.

**Mainnet deploy checklist (all PASS or no deploy):** statics clean or triaged · invariants pass at high run count (≥10M calls cumulative) · coverage thresholds met · sig + canonicalization differentials green · soak complete incl. drills · deploy scripts idempotent with dry-run output reviewed · sources verified on the X Layer explorer · admin/oracle/writer keys documented with rotation runbook tested · campaign deposit caps configured · gas measurements published.

---

## 29. Day 0 gate (build task #0 — infra validation before feature work)

Each check produces named PASS/FAIL evidence. **Hard gate:** no feature code beyond spikes until D0.1, D0.3, D0.4, D0.5 pass. D0.6–D0.9 may run in parallel.

| # | Check | Evidence (PASS artifact) |
|---|---|---|
| **D0.1** | **x402/facilitator hello-world — PASS.** One real, paid A2MCP call settled end-to-end on X Layer mainnet via OKX's hosted facilitator; independently verified on rpc.xlayer.tech rather than taken on the facilitator's word. Resolves §23 Q3 | tx `0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc` + request/response log + settlement record, in internal/day0/D0.1-evidence/ |
| **D0.2** | **ASP listing dry-run** — walk the OKX.AI registration flow, capture required fields + review requirements; listing copy drafted from Brand section | field inventory + draft listing copy |
| **D0.3** | **X Layer basics** — chain IDs, mainnet + testnet RPCs, explorer, faucet; **USDT/USDG contract addresses + decimals from the official token list** (resolves Q5) — done; ops wallet funded with OKB gas — **target corrected to mainnet** (no testnet facilitator exists, per D0.1), remaining open | `chains.ts` constants file + funded-wallet tx link (mainnet) |
| **D0.4** | **Toolchain** — Foundry + solc pinned; **Slither and Aderyn run green on a scaffold contract**; CI workflow executing the §28 static stage | CI run link + both tool reports on scaffold |
| **D0.5** | **Canonicalization spike** — JS RFC-8785 hash == Solidity abi.encode hash for a fixture SpendIntent | passing differential test file |
| **D0.6** | **Photon control channel** — ten explicit checks, each independently PASS/FAIL: (1) send message to bound iMessage handle, (2) receive inbound reply with a stable handle/spaceId, (3) create a poll if the plan supports it, (4) receive a poll-vote event if available, (5) confirm a sender-identity field is present on inbound events, (6) test shared-line behavior (don't bind to a pooled/rotating number), (7) measure round-trip latency, (8) force a stream reconnect and confirm recovery, (9) document rate limits + plan pricing, (10) confirm Railway/remote-mode deploy compatibility. Poll/mini-app support (rows 3–4) is optional for PASS overall — text-code approval (rows 1,2,5) is the hard requirement | per-row transcript/payload/note; explicit PASS/FAIL per row, not just overall |
| **D0.7** | **Telegram fallback** — bot token, echo, button-approval roundtrip | echo transcript |
| **D0.8** | **Repo scaffold** — public skeleton per polish standard (README structure, LICENSE, CONTRIBUTING.md, docs/architecture.md linked); /internal gitignored (PRD lives there) | repo tree |
| **D0.9** | **APP broker-role docs read** — is the broker self-hostable/configurable? Decides Mode D demo form (§22.8, resolves Q4) | one-page disposition note in /internal |

Exit review: all rows PASS/flagged → lock §22 sequence and start step 1. Any FAIL on D0.1/D0.3/D0.4/D0.5 → resolve before any feature work; a FAIL on D0.6 falls back to Telegram-primary while Photon access is sorted (channels are policy-config, not code forks).