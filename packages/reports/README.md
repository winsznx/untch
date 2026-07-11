# @untch/reports — `generate_dispute_packet` & `reconcile_agent_spend` (PRD §11)

Two paid A2MCP report tools that **aggregate durable history into an anchored evidence artifact**. They
produce nothing new: they select, sum, and hash the outputs the four subsystems already wrote for real —
policy-engine DECISION receipts, proof-engine VERIFY receipts, the receipt writer's anchored receipts,
and the escalation service's resolution history — then anchor the artifact's hash on-chain.

- **`generate_dispute_packet`** — $0.50, per `intentRef`. One intent → one evidence bundle → one anchor.
- **`reconcile_agent_spend`** — $0.25/day · $1.00/wk (see [Reconcile pricing](#reconcile-pricing)), per
  `agentId` + `period`. One agent + period → one reconciliation report → one anchor.

**No LLM anywhere in the assembly path (invariant I1).** This is data aggregation and hashing, not
interpretation. If narrative text is ever added to these reports, it will be sandboxed and labeled, the
same as §7.6 already specifies for A2A audit reports — but that is explicitly not in this build.

---

## The judgment call: dispute packets reuse `AuditAnchored` — decision and justification

§10.3 names exactly two non-receipt anchor events: `ScoreAnchored` (Bureau score roots) and
`AuditAnchored(reportHash, agentId, period)` (periodic audit/reconciliation reports). There is **no
separate "dispute packet" anchor primitive**, and this build does **not invent one**. Both report tools
anchor via the existing, already-deployed `UntchReceipts.anchorAudit` → `AuditAnchored`.

**Why reuse is correct, not a shortcut:**

1. **The PRD already does this.** §7.6 (A2A audit fulfillment) routes `REPORT + DISPUTE_PACKETS ─▶ ANCHOR
   AuditAnchored(hash)`. The spec itself already treats a dispute packet as an `AuditAnchored` payload.
   Reusing it follows precedent verbatim; inventing a `DisputeAnchored` event would *contradict* §7.6.
2. **The event's fields fit both artifacts.** `reportHash` = keccak of the assembled artifact;
   `agentId` = the subject agent (the intent's own agent for a dispute, the reconciled agent for a
   report); `period` = the day the disputed activity occurred (dispute) or the reconciliation window
   start (report). Nothing about a dispute packet needs a field `AuditAnchored` lacks.
3. **On-chain carries hashes only (§10.3).** The distinction between *kinds* of audit artifact lives in
   the off-chain artifact the `reportHash` commits to — every artifact carries an explicit `kind`
   (`"DISPUTE_PACKET"` / `"RECONCILE"`) and `version`. A new event type would move a distinction that
   belongs in the committed content into the wire format, forking the indexer's event contract for zero
   capability gain.
4. **A new primitive can't represent anything the reuse can't.** `anchorAudit` already enforces a
   non-zero `reportHash` (`ZeroReportHash`) and is writer-gated — the exact guarantees a dispute anchor
   needs. There is no property of a dispute packet that `AuditAnchored` cannot express.

So: **reuse `AuditAnchored` for both tools.** The only code added on-chain was surfacing `anchorAudit` +
`AuditAnchored` in the shared `UNTCH_RECEIPTS_ABI` (they were already in the deployed contract; the ABI
subset just hadn't listed them yet).

---

## What each tool's output actually contains

### `generate_dispute_packet` → `{ intentHash, reportHash, packet, anchor }`

`packet` (kind `DISPUTE_PACKET`) is assembled from **only** what durably exists for the intent:

| Section | Source subsystem | Sparse behavior |
|---|---|---|
| `decision` | the intent's DECISION receipt (terminal §7.1 outcome, amount, on-chain anchor) | `present:false` if none |
| `verification.results[]` | the intent's VERIFY receipt(s) (proof-engine result, tier, provenance) | `[]` if no verify was called — **never fabricated** |
| `escalation.records[]` | the escalation service's resolution history for the intent | `[]` if none |
| `receipts[]` | every receipt with its `txHash`/`blockNumber` anchor status | — |
| `ledger[]` | the SPEND/BLOCK_SAVED effect the receipts produced | — |
| `timeline[]` | merged, chronologically sorted from the above rows' own timestamps | — |
| `completeness` | booleans + human notes stating exactly what is missing | always present |

### `reconcile_agent_spend` → `{ agentId, period, reportHash, report, anchor }`

`report` (kind `RECONCILE`) over the agent's history in the period:

- **`spend`** — money that actually moved (ledger `SPEND` rows), summed per token.
- **`blockedWaste`** — money that would have moved but was blocked, from **`BLOCKED_*` decisions only**
  (the upper-bound cost of those attempts — see the honest note the report carries).
- **`escalatedExposure`** — money **held** for operator decision (`ESCALATED_*`), reported **separately**
  from waste because an escalation may still be approved. Not folded into "saved" totals.
- **`decisionBreakdown`**, **`escalations` (by resolution)**, **`verifications`** (pass/fail/skipped/…),
  **`receipts`** (anchored vs unanchored counts).

`anchor` is `{ anchored:true, event:"AuditAnchored", txHash, blockNumber, period, … }` when a writer is
wired, else `{ anchored:false, txHash:null, note }` — see the anchoring posture below.

---

## Honest gaps (nothing is padded to look complete)

- **Sparse history stays sparse.** A dispute packet for an intent with no verify call shows
  `verification.present:false` and an empty `results[]`; an intent with zero history is an honest empty
  record (still hashable — it commits to "we looked and found nothing"). A reconcile for an idle agent is
  all-zero totals, explicitly labeled honest-empty. Tested in `dispute.test.ts` / `reconcile.test.ts`.
- **No granular rule trace in durable history.** The §8.2 per-rule decision trace is returned *live* by
  `preflight_payment`; it is **not persisted** — only the terminal `decision` code is. The dispute packet
  records that terminal outcome (decoded to its §7.1 name), not a reconstructed rule ladder, and says so
  in `completeness.notes`. Reconstructing the full trace would require persisting it (a receipt-writer
  schema change), which this build does not do.
- **Anchoring posture: the seller does not hold the writer key by default.** Matching the trust-bureau
  posture, per-call on-chain anchoring on the seller is **off** unless `REPORT_ANCHOR_WRITER_KEY` is set;
  by default the tool returns the assembled artifact + `reportHash` with `anchor:null`, and the anchor is
  produced by the anchor job / the prove scripts (which hold the key). The `reportHash` returned **is**
  the exact value that gets anchored — a caller can recompute it from the artifact and match the on-chain
  `AuditAnchored`. When `REPORT_ANCHOR_WRITER_KEY` *is* set, the tool anchors per call and returns the
  real tx.
- <a name="reconcile-pricing"></a>**Reconcile pricing is single-rate in this build.** §11 lists
  $0.25/day · $1.00/wk, but the x402 middleware prices one static value per route. This build charges the
  **$0.25 base rate for both** day and week reports; the differentiated (discounted-week) price is
  deferred with the dashboard wallet-connect flow — the same honest posture the policy tools already
  take. The tool produces day *and* week reports correctly; only the differentiated price is deferred.

---

## Real anchored proofs (X Layer testnet, independently verified)

Both proofs assemble a real artifact from **real** policy-engine + proof-engine + receipt-writer outputs,
hash it, anchor the hash via a real writer-signed `anchorAudit` tx, and re-read the `AuditAnchored` event
by raw `eth_getLogs` — matched on `reportHash+agentId+period` where `reportHash` is **recomputed** from the
artifact, not taken from the anchor call's return.

```
WRITER_PRIVATE_KEY=0x… pnpm --filter @untch/reports prove:dispute-anchor
WRITER_PRIVATE_KEY=0x… pnpm --filter @untch/reports prove:reconcile-anchor
```

Contract: `UntchReceipts` `0x0c64997277b7d94d2999dea22a123cac56334863` (X Layer testnet, id 1952).

| Tool | reportHash | anchor tx (`AuditAnchored`) |
|---|---|---|
| `generate_dispute_packet` | `0xcb91ab04e6225984226b37402dadac7c18b55ba9f33354c83996fe1197ba12e7` | [`0xcb577c8e…caefcb699`](https://www.oklink.com/x-layer-testnet/tx/0xcb577c8e55f7f7a4777d2d0eb04d84b2422dcd2016f7e0291c12872caefcb699) |
| `reconcile_agent_spend` | `0x8e3763a925f56b776936d9a0a08ca3c5a7cad70a73a90fe4c074fa33ee0257e6` | [`0x23b356d5…bae86494`](https://www.oklink.com/x-layer-testnet/tx/0x23b356d5621f94adcb74b66a7beef45ce37e4b7628b83a5fea9dab73bae86494) |

Both txs are `status:0x1`, and each `AuditAnchored` log carries its `reportHash` — confirmed with a raw
`eth_getTransactionReceipt` curl, entirely independent of this package's code.

> The proofs anchor the **report hash**; the underlying receipts are not themselves anchored in these
> self-contained scripts, so the artifact honestly labels them not-yet-anchored (`status:"BATCHED"`,
> `txHash:null`). In production those same receipts are anchored by the receipt writer's own
> `ReceiptLogged` path.

---

## Layout

```
src/
  datasource.ts          ReportDataSource + row types (receipts / ledger / escalations)
  datasource-pg.ts       Postgres reads over the SHARED tables (no writes — reports are derived views)
  datasource-memory.ts   in-memory source for tests + the anchor proofs
  codes.ts               decode receipt decision/verify uint8s → names (built from receipt-writer's map)
  period.ts              parse "YYYY-MM-DD" / "YYYY-Www" → [from,to) window + uint64 period code
  dispute.ts             assembleDisputePacket / hashDisputePacket (pure)
  reconcile.ts           assembleReconcileReport / hashReconcileReport (pure)
  anchor.ts              AuditAnchorer — real anchorAudit tx + raw-RPC AuditAnchored verification
  config.ts              testnet chain / contract / rpc defaults
  prove-*.ts             the two real end-to-end anchor proofs
test/                    period, dispute (incl honest-sparse/empty), reconcile, anchor decode
```

The seller wires these as priced x402 routes in `services/asp` (`report-handlers.ts`, `report-wiring.ts`,
`server.ts`), identical in pattern to every prior tool.
