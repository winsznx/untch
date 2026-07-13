# @untch/receipt-writer (PRD §7.4 / §10.3)

The receipt writer turns preflight_payment **decisions** into a durable ledger and anchors them to the
deployed `UntchReceipts` contract on X Layer testnet. It is the first Untch component with real
persistent state: **Postgres is the source of truth; chain anchoring is downstream of durability.** A
receipt is safe the instant `preflight_payment` returns — whether or not it ever reaches the chain.

```
seller preflight_payment ──enqueue──▶ Postgres (receipt QUEUED + ledger entry, durable)
                                   └─▶ Redis/BullMQ tick ──▶ worker
worker: QUEUED ─▶ BATCHED (N or T) ─▶ SUBMITTED(txHash) ─▶ CONFIRMED (finality depth)
                     │ RPC/nonce error ─▶ retry ×N backoff ─▶ DEGRADED_UNANCHORED (ledger stays authoritative)
                     └ reorg ─▶ re-verify inclusion ─▶ resubmit if dropped
```

## Timelock-delay decision (kept at 60s for testnet)

The deployed `UntchReceipts` (`0x0c64…4863`, X Layer testnet 1952) has an **immutable** 60-second
admin timelock. Before provisioning the production writer key through it, that value was re-examined
and deliberately **kept** — redeploying to get a longer delay buys zero real security on testnet
(burner keys, no funds) and would orphan the OKLink-verified contract that holds the measured
gas/receipt proof. **Mainnet is gated:** a mainnet `UntchReceipts` MUST deploy with a real hours-to-
days delay (recommended 48h) plus a constructor minimum-delay floor, because the delay is a deploy-
time decision with no fix-later path. Full write-up + reasoning: [`docs/TIMELOCK-DELAY-DECISION.md`](docs/TIMELOCK-DELAY-DECISION.md).

## Storage (real, durable — not in-memory)

Every prior Untch component used in-memory state by design (correct for pure-logic testing). This one
cannot: a queued-but-unanchored receipt must survive a process restart. So it stands up:

- **Postgres** — the durable source of truth. Minimal schema subset (not the whole §8 data model):
  - `receipts` — the anchorable §10.3 receipt records + their §7.4 status.
  - `ledger_entries` — append-only, written **at decision time** inside the same transaction as the
    receipt. Authoritative regardless of chain state; corrections are reversal rows, never `UPDATE`.
  - `batches` — the state machine's own per-batch chain bookkeeping (for confirm + reorg re-checks).
- **Redis + BullMQ** (§22) — the batching signal transport. A "tick" job per receipt nudges the
  worker's batcher. Redis holds **no authoritative state**: a lost tick never loses a receipt, because
  the worker's safety sweep re-scans QUEUED rows from Postgres.

## State machine (§7.4, as implemented)

| State | Meaning |
|---|---|
| `QUEUED` | durably written by the seller; not yet batched |
| `BATCHED` | atomically claimed into a batch (`FOR UPDATE SKIP LOCKED`), about to submit |
| `SUBMITTED` | `logReceipts` tx sent; `tx_hash` recorded (not yet final) |
| `CONFIRMED` | included at ≥ `CONFIRM_DEPTH` confirmations; on-chain `BatchLogged.batchId` recorded |
| `DEGRADED_UNANCHORED` | submit retries exhausted; **ledger remains authoritative**, batch re-drivable |

- **Batching** fires on **N receipts** (`BATCH_MAX_SIZE`) or **T seconds** (`BATCH_MAX_WAIT_MS`),
  whichever first (`src/batcher.ts`).
- **Retry/backoff**: submit failures retry with exponential backoff up to `RETRY_MAX`, then
  `DEGRADED_UNANCHORED` (`src/anchorer.ts`). Nothing is lost — the receipt + ledger rows stay.
- **Reorg**: a reconcile sweep re-verifies each `SUBMITTED` batch by raw RPC receipt lookup; if the tx
  was dropped it resubmits, if included at depth it confirms.

The batching/retry/reorg logic is driven entirely through the `ReceiptsRepo` + `ChainAnchor`
interfaces, so it is unit-tested with an in-memory repo and a fake chain — **no Postgres, no RPC**.

## Provisioning + deploy runbook

```bash
# 1. Generate the writer wallet (fresh burner; key → packages/receipt-writer/.env, gitignored)
pnpm tsx scripts/gen-writer-wallet.ts
#    Fund the printed address with testnet OKB: https://www.okx.com/xlayer/faucet

# 2. Provision it as an authorized writer THROUGH THE REAL 60s TIMELOCK (admin runs this).
#    Real testnet propose → prove-early-revert (eth_call) → 60s wait → execute → raw readback.
DEPLOYER_PRIVATE_KEY=0x<ADMIN_KEY> WRITER_ADDRESS=0x<writer> \
  BROADCAST=1 pnpm tsx scripts/provision-receipt-writer.ts
#    Writes contracts/deploy/receipt-writer-provisioning-receipt.json

# 3. Migrate + run the worker (Railway service; needs DATABASE_URL, REDIS_URL, WRITER_PRIVATE_KEY)
pnpm --filter @untch/receipt-writer migrate
pnpm --filter @untch/receipt-writer worker
```

## Environment

| Var | Who | Purpose |
|---|---|---|
| `DATABASE_URL` | seller + worker | Postgres connection (Railway managed) |
| `REDIS_URL` | seller + worker | Redis connection (Railway managed) |
| `WRITER_PRIVATE_KEY` | worker only | the authorized writer signing key |
| `RPC_URL` | worker | X Layer testnet RPC (default `testrpc.xlayer.tech`) |
| `RECEIPTS_CONTRACT` | worker | override UntchReceipts address (defaults to deployed testnet) |
| `BATCH_MAX_SIZE` / `BATCH_MAX_WAIT_MS` | worker | N / T batch triggers (default 25 / 10000) |
| `RETRY_MAX` / `RETRY_BACKOFF_BASE_MS` | worker | retry budget + base backoff (default 5 / 500) |
| `CONFIRM_DEPTH` / `RECONCILE_INTERVAL_MS` | worker | finality depth + reconcile cadence (default 3 / 5000) |

The seller never gets `WRITER_PRIVATE_KEY` or `RPC_URL` — it only enqueues.

## What is still stubbed (honest scope)

- **Only `preflight_payment` decisions produce receipts.** `verify_delivery`-driven receipts do **not
  exist** yet: the Proof Engine (§7.3) isn't built, so there is no delivery-verification result to
  record. Every receipt here is `kind = DECISION` with `verifyResult = 0`. When the Proof Engine
  lands, `VERIFY` receipts join through the same enqueue path.
- **Score/audit anchoring** (`anchorScore` / `anchorAudit`) is not driven by this service yet.
- **Reverted-batch split-into-singles** (§7.4) is defended-against but degrades rather than truly
  splitting — `logReceipts` only reverts on non-writer/empty (both impossible here), so a real partial
  failure has no path to occur; a genuine split would need partial-failure info the append-only log
  can't provide.
- **Nonce management** relies on sequential awaited sends; explicit nonce tracking is a hardening
  follow-up for high submission rates.

## Tests

```bash
pnpm --filter @untch/receipt-writer test
```

Covers both batch triggers (N and T), retry/backoff under simulated RPC failure (→ SUBMITTED and →
DEGRADED_UNANCHORED with nothing lost), the reorg re-verify/resubmit → CONFIRMED path, and the
decision → receipt/ledger mapping. The one test that matters most is the **real end-to-end proof** —
see the repo-level runbook — where a live `preflight_payment` produces a receipt that really batches
and really anchors to `UntchReceipts`, verified independently via `eth_getLogs`.
