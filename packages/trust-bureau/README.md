# @untch/trust-bureau — Untch Bureau (PRD §12)

Deterministic, weighted, **no-LLM (I1)** vendor + buyer reliability scoring. Every score carries a
per-score uncertainty σ, and **enforcement always uses the lower-confidence bound `LCB = score − z·σ`**
(z = 1.28 default), never the raw score. Epoch snapshots (6h) are merkle-rooted and anchored on-chain via
`UntchReceipts.anchorScore` (§10.3 `ScoreAnchored`).

This README is the honesty manifest: exactly what is real, what is a cold-start prior, and what is
deliberately deferred. Nothing here is faked, and nothing is silently absent.

---

## 1. Marketplace-access finding (time-boxed check)

**VERDICT: NOT-CONFIRMED.** There is no confirmed, documented, working way to query OKX.AI marketplace
listing / review / rating data right now.

What was checked:

- **Documented marketplace API with listing/review/rating endpoints** — not found. OKX AI's learn pages
  (`okx.com/learn/okx-ai`, `.../agent-payments-protocol`) describe reputation as an on-chain record per
  agent identity, but surface no endpoint returning ratings/reviews/listing details. The Agent Payments
  Protocol / A2MCP material describes payment challenges (x402-style 402), not a reputation read API.
- **Scrapeable public marketplace page** — `www.okx.ai/agents` returns HTTP 403 to a plain fetch
  (bot-protected / client-rendered SPA). Not cleanly scrapeable, and no documented ratings schema.
- **Developer docs** (`web3.okx.com/onchainos`, dev-docs) — document wallet / market-data / DEX / payment
  APIs and a Plugin Store with "Official / Verified Partner" trust badges, but no documented API to query
  per-vendor star ratings or reviews.

This matches Broker Guard's and Photon's own unresolved external dependencies. **So the §12 "Data-source
fallback" is not a hypothetical backup here — it is the PRIMARY path** for the three marketplace-only
features. This is not scope to wire against now; if a real listing/review source is later confirmed, it is
a separate task to add it.

---

## 2. Feature manifest (real vs cold-start)

### Vendor features (§12) — four REAL, three cold-start-honest

| Feature | Weight | Status | Source |
|---|---|---|---|
| `track_record_depth` | 0.20 | **REAL (observed)** | log-scaled count of APPROVED, receipted orders for the vendor (UntchReceipts history) |
| `delivery_consistency` | 0.20 | **REAL (observed)** | provenance-weighted T0 tier-pass rate over real `verify_delivery` results |
| `dispute_signal` | 0.15 | **REAL (observed)** | (escalation deny/timeout + verify-fail) per 100 receipted orders — internal proxy for arbitration data we don't have |
| `wallet_operational_profile` | 0.10 | **REAL (observed)** | direct RPC on the payout address (tx-count activity, native reserve, EOA/contract) |
| `rating_quality` | 0.20 | **cold-start prior** | marketplace ratings — unavailable (see finding). Category baseline prior, renormalized out, σ widened |
| `price_sanity` | 0.075 | **cold-start prior** | marketplace price data — unavailable. Category baseline prior |
| `claims_consistency` | 0.075 | **cold-start prior** | marketplace listing claims — unavailable. Category baseline prior |

`delivery_consistency` weights a **store-committed** T0 result (the seller's authoritative committed
intent) at full confidence and a **caller-supplied** result (a store miss, lower confidence) at half — the
exact distinction the `verify_delivery` provenance fix made available, now a queryable `receipts.provenance`
column.

`wallet_operational_profile` is honest about depth: it uses the three real point-in-time RPC signals; the
richer §12 signals (first-seen **age**, activity **regularity**, interaction **diversity**) need a tx/log
indexer and are a **deferred enrichment, not claimed**. That honesty is why the feature's σ is not tiny.

### Buyer hygiene (§12) — fully REAL, no gaps

| Feature | Weight | Source |
|---|---|---|
| `unbound_acceptance_rate` | 0.30 | fraction of verify events that were `VERIFY_SKIPPED_UNCOMMITTED` (paid without committed acceptance criteria) |
| `ignores_verification_rate` | 0.30 | fraction of `VERIFY_FAILED` deliveries followed by a later approved spend to the same vendor |
| `out_of_policy_rate` | 0.25 | fraction of preflight decisions that were `BLOCKED_*` (policy engine's own trace history, §8.2) |
| `late_escalation_rate` | 0.15 | fraction of escalations that timed out or resolved past the approval window (escalation service timing) |

Every buyer signal maps onto a subsystem already built, so **none needs a cold-start fallback**. Buyer
hygiene never blocks a buyer's own spend (§12) — it annotates counterparty risk.

---

## 3. The renormalization + σ-widening math (§12 fallback, implemented for real)

When a feature's real source is unavailable, its weight is **renormalized across the observed features**
and σ is **widened** by a term proportional to the weight removed:

```
Wobs   = Σ baseWeightᵢ over observed features                 (= 0.65 for a vendor: the four real weights)
wnormᵢ = baseWeightᵢ / Wobs                                    (renormalized to sum to 1 over observed)
score  = Σ wnormᵢ · valueᵢ                                     (observed features only — a prior never enters)
fmiss  = (Σ baseWeightⱼ over cold-start) / Wtotal              (= 0.35 for a vendor)
Vobs   = Σ wnormᵢ² · σᵢ²                                       (point-estimate variance from observed σ)
Vmiss  = fmiss · PRIOR_STD²                                    (the §12 "σ increases" term; PRIOR_STD = 22)
σ      = sqrt(Vobs + Vmiss)
LCB    = clamp(score − z·σ, 0, 100)
```

Because 0.35 of a vendor's intended signal is always missing in this build, `Vmiss ≈ 0.35·22² ≈ 169` ⇒ a σ
floor of ~13 points, so **every vendor LCB is conservative even when the raw score looks fine** — exactly
the §12 behavior: missing marketplace data tightens enforcement automatically. The cold-start priors are
reported (for transparency) with `source: "cold-start-prior"`, `implemented: false`, and `weightApplied: 0`
— **never presented as observed data** (HARD RULE, enforced in the response, not just a code comment).

Buyer hygiene runs the same renormalizer with all features observed ⇒ `fmiss = 0`, no widening term.

### LCB boundary behavior (tested)

- σ = 0 ⇒ LCB = score exactly.
- very high σ ⇒ LCB drops to the 0 floor (enforcement tightens toward block).
- cold-start ⇒ wide σ pulls the LCB well below the raw score (conservative, not floored, for a good vendor).

---

## 4. Deliberately deferred (named, not silent)

- **Anti-gaming** (wallet-cluster self-dealing discount, review-velocity damping): there is essentially no
  real gaming to detect or validate against in a build this size, and a detector tuned on non-existent
  adversarial data would be theater. This ships the **hook** (`applyAntiGaming` + `AntiGamingDiscount`,
  wired into the scoring path as a no-op that can only ever *lower* a value or *widen* a σ, never inflate),
  so landing a real detector later is a drop-in. Same category as proof-engine's T1/T2 stubs.
- **Appeal / correction flow**: needs the §15 dashboard (a vendor cannot yet see their score), so the
  workflow is deferred. The **disclaimer text is shipped now**, on every score response.

---

## 5. Disclaimer (shipped on every response)

> Untch scores are operational confidence signals, not legal, financial, or criminal-risk determinations.
> They are computed from receipt-backed activity and public on-chain data with a stated uncertainty, and
> enforcement uses the lower-confidence bound, not the headline number. Do not use a score as the sole
> basis for a legal, credit, or compliance decision.

---

## 6. Tools, schema, anchoring

- **MCP tools** (live on the seller, priced $0.20 each per §11, real USDT0 via the OKX x402 facilitator):
  `score_vendor` (`vendorId` | `endpoint`/`host`; optional `payoutAddress`) and `score_buyer` (`agentId`).
  `listingId` / `operatorRef` are **honestly rejected** — resolving them needs marketplace data / the
  dashboard map, neither of which exists. Both responses carry the full feature breakdown + disclaimer.
- **Schema**: `score_snapshots` (§8) in the **shared** Postgres instance (migration `006`, no new
  instance): `subject, subject_id, epoch, score, sigma, lcb, z, band, features JSONB, anchored_root?,
  computed_at`. A queryable `receipts.provenance` column (migration `005`) makes the delivery-consistency
  provenance weighting real.
- **On-chain anchoring**: `ScoreAnchorer` merkle-roots an epoch's snapshots (deterministic keccak256,
  commutative pairing) and submits a **real** `anchorScore(root, epoch, subjectKind)` on the deployed
  UntchReceipts, then **independently verifies** `ScoreAnchored` via raw RPC (decoded client-side, matched
  against the independently recomputed root — not the service's own report).

### Real end-to-end proof

`src/prove-score-anchor.ts` runs the whole path with real proof-engine T0 outputs, real on-chain RPC wallet
profiling, real deterministic scoring, a real anchor tx, and independent raw-RPC verification:

```
WRITER_PRIVATE_KEY=0x… pnpm --filter @untch/trust-bureau prove:score-anchor
```

Latest proven run (X Layer testnet, UntchReceipts `0x0c64997277b7d94d2999dea22a123cac56334863`):

- vendor score 85.16 · σ 14.78 · **LCB 66.24** · band STABLE · epoch 82581 (four real features + three
  cold-start priors renormalized away; wallet feature from real RPC: txCount 69, reserve, EOA)
- buyer score 100.00 · σ 8.70 · LCB 88.86 · band TRUSTED (fully real hygiene)
- merkle root `0xcb1e3604d401e6b234afb4a532bdfdd68b2fbe5e23862c0241d5f8b4b8d9e86e`
- **anchor tx `0x6b56d12d4a1c43f64d7bbc31565eb418b1f3d37a62636df4b589a702eba4687d`** — ScoreAnchored
  independently verified via raw `eth_getLogs`.

---

## 7. Tests

```
pnpm --filter @untch/trust-bureau test     # 28 tests: each feature, renormalization, LCB boundaries,
                                           # merkle determinism/tamper-evidence, disclaimer, e2e scoring
```

Handler-level tests for the two priced tools live in `services/asp/test/score-handlers.test.ts`.

## 8. Hard rules honored

- **No LLM anywhere in the scoring path (I1)** — deterministic weighted math only.
- **A cold-start prior is never presented as observed data** — the distinction is in the response
  (`source` / `implemented`), not just a code comment.
- **Real on-chain anchoring transaction, no mocked settlement** — verified independently by raw RPC.
