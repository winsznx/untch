-- PRD §7.4 / §8 — the MINIMAL durable schema the receipt writer needs. Deliberately NOT the whole
-- §8 data model: only (1) the `receipts` this component anchors, (2) the `ledger_entries` it produces
-- at decision time, and (3) an internal `batches` table that is the state machine's own bookkeeping
-- for the QUEUED→BATCHED→SUBMITTED→CONFIRMED / DEGRADED_UNANCHORED transitions and reorg re-checks.
--
-- Idempotent: safe to run repeatedly (migration runner records applied files; every statement guards
-- with IF NOT EXISTS). Postgres is the source of truth — a receipt/ledger row is durable the instant
-- preflight_payment returns, independent of whether the batch ever reaches the chain (§7.4: "ledger
-- stays authoritative and durable in Postgres regardless of chain state — nothing is ever lost").

-- ── batches: the state machine's per-batch chain bookkeeping ────────────────────────────────────
-- One row per logReceipts attempt-group. `onchain_batch_id` is UntchReceipts.BatchLogged.batchId once
-- known; `tx_hash` is the current submission (rewritten on a reorg-driven resubmit). status ∈
-- PENDING (claimed, not yet submitted) | SUBMITTED | CONFIRMED | DEGRADED_UNANCHORED.
CREATE TABLE IF NOT EXISTS batches (
  id               BIGSERIAL PRIMARY KEY,
  status           TEXT        NOT NULL DEFAULT 'PENDING',
  receipt_count    INTEGER     NOT NULL,
  onchain_batch_id BIGINT,
  tx_hash          TEXT,
  confirmed_block  BIGINT,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  last_error       TEXT,
  submitted_at     TIMESTAMPTZ,
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_status_idx ON batches (status, created_at);

-- ── receipts: the anchorable §10.3 receipt records (subset of §8 `receipts`) ─────────────────────
-- `receipt_id` is the caller-supplied bytes32 that UntchReceipts records verbatim (judgment call 2)
-- AND the polling key a caller uses to check status. status mirrors §7.4:
--   QUEUED → BATCHED → SUBMITTED → CONFIRMED, with DEGRADED_UNANCHORED as the retries-exhausted state.
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id     TEXT        PRIMARY KEY,
  kind           TEXT        NOT NULL DEFAULT 'DECISION',
  status         TEXT        NOT NULL DEFAULT 'QUEUED',
  schema_version INTEGER     NOT NULL DEFAULT 1,

  intent_hash    TEXT        NOT NULL,
  policy_id      NUMERIC     NOT NULL,
  policy_hash    TEXT        NOT NULL,
  agent_id       TEXT        NOT NULL,
  vendor_id      TEXT        NOT NULL,
  amount         NUMERIC     NOT NULL,
  token          TEXT        NOT NULL,
  category       TEXT        NOT NULL,
  pay_type       SMALLINT    NOT NULL,
  task_hash      TEXT        NOT NULL,
  decision       SMALLINT    NOT NULL,
  verify_result  SMALLINT    NOT NULL DEFAULT 0,
  proof_tier     SMALLINT    NOT NULL DEFAULT 0,
  metadata_hash  TEXT        NOT NULL,

  batch_id       BIGINT      REFERENCES batches (id),
  tx_hash        TEXT,
  block_number   BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receipts_status_idx ON receipts (status, created_at);
CREATE INDEX IF NOT EXISTS receipts_batch_idx  ON receipts (batch_id);

-- ── ledger_entries: append-only, written at decision time (§8) ───────────────────────────────────
-- This is the authoritative record the §7.4 note protects: it is written inside the same transaction
-- as the receipt INSERT and is NEVER mutated by chain state. Corrections are reversal rows, never
-- UPDATE. type ∈ SPEND (APPROVED) | BLOCK_SAVED (BLOCKED_*/ESCALATED_* — spend withheld) | FEE_UNTCH |
-- REFUND (the latter two not produced by this preflight-only slice yet).
CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL   PRIMARY KEY,
  receipt_id   TEXT        NOT NULL REFERENCES receipts (receipt_id),
  agent_id     TEXT        NOT NULL,
  type         TEXT        NOT NULL,
  amount       NUMERIC     NOT NULL,
  token        TEXT        NOT NULL,
  counterparty TEXT,
  day_key      TEXT        NOT NULL,
  category_key TEXT,
  vendor_key   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_agent_idx ON ledger_entries (agent_id, created_at);
