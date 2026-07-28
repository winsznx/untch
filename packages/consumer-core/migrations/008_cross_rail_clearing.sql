-- 008_cross_rail_clearing.sql
--
-- Closes the double-expense defect in cross-rail execution.
--
-- WHAT WAS WRONG. When a user funds on rail A and the provider is paid on rail B, migration 007's
-- ledger booked the cost TWICE: once as COST_OF_GOODS on rail A (in RECOGNITION) and again as
-- PROVIDER_SETTLEMENT on rail B (in SETTLEMENT). CROSS_RAIL_CLEARING existed as an account kind and
-- was documented as the join between the two rails, but nothing ever wrote to it. The visible
-- symptom was rail B's TREASURY position marching monotonically negative — correct arithmetic on a
-- wrong model. Rail B's float really had gone down; there was simply no entry saying rail A was
-- holding the value that replaces it.
--
-- WHAT THIS CHANGES. Cross-rail RECOGNITION now credits CROSS_RAIL_CLEARING on the funding rail
-- instead of COST_OF_GOODS. The expense is recorded exactly once, on the rail where money actually
-- left. The clearing balance is the operator's work queue: value one rail owes another. Retiring it
-- is a real movement (exchange, bridge, top-up), and that movement is now recordable as a
-- TREASURY_TRANSFER group pair — hence the two schema changes below.
--
-- Same-rail execution is unaffected: COST_OF_GOODS is still the direct expense, no clearing involved.
--
-- No historical rows are rewritten. consumer_ledger_entries is append-only by RULE and stays that
-- way; the one intent already settled cross-rail keeps its original entries and is corrected, if the
-- operator chooses to correct it, by a visible ADJUSTMENT group. This migration only widens what the
-- schema will ACCEPT.

-- ── 1. TREASURY_TRANSFER becomes a valid group kind ─────────────────────────────────────────────
ALTER TABLE consumer_ledger_groups DROP CONSTRAINT IF EXISTS consumer_ledger_groups_kind_check;
ALTER TABLE consumer_ledger_groups ADD CONSTRAINT consumer_ledger_groups_kind_check
  CHECK (kind IN ('FUNDING','SETTLEMENT','RECOGNITION','REFUND','SUSPENSE_MOVE','ADJUSTMENT','TREASURY_TRANSFER'));

-- ── 2. A treasury sweep belongs to no single intent ─────────────────────────────────────────────
-- It retires a clearing position accumulated across many intents. Forcing a synthetic intent_id
-- would make the group_once index reject the second sweep, and would attribute a pooled movement to
-- one arbitrary user's intent in every downstream report.
ALTER TABLE consumer_ledger_groups ALTER COLUMN intent_id DROP NOT NULL;

-- The once-per-intent guarantee is unchanged for real intents. It is now written so it does not rely
-- on Postgres treating NULLs as distinct inside a unique index: sweeps are excluded explicitly.
DROP INDEX IF EXISTS consumer_ledger_group_once_idx;
CREATE UNIQUE INDEX IF NOT EXISTS consumer_ledger_group_once_idx
  ON consumer_ledger_groups (intent_id, kind)
  WHERE kind <> 'ADJUSTMENT' AND kind <> 'TREASURY_TRANSFER' AND intent_id IS NOT NULL;

-- Sweeps are queried by rail and time, never by intent.
CREATE INDEX IF NOT EXISTS consumer_ledger_groups_transfer_idx
  ON consumer_ledger_groups (chain, token, created_at)
  WHERE kind = 'TREASURY_TRANSFER';
