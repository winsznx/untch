-- §12 Trust Bureau readiness — make a VERIFY receipt's intent PROVENANCE queryable.
--
-- verify_delivery already records whether the T0 result was verified against the seller's COMMITTED
-- stored intent ("store-committed", authoritative) or against CALLER-supplied inline data on a store
-- miss ("caller-supplied", lower confidence). Until now that distinction was committed only inside the
-- receipt's off-chain metadata_hash. The Bureau's `delivery_consistency` feature (§12) must WEIGHT a
-- store-committed pass higher than a caller-supplied one, so the distinction has to be a queryable
-- column, not just a hash preimage. This adds it — nullable, because DECISION receipts (and any
-- pre-existing VERIFY rows written before this column existed) have no provenance.
--
-- Additive + idempotent (IF NOT EXISTS), matching the forward-only, never-mutate posture of 001.

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS provenance TEXT;

-- The Bureau reads VERIFY receipts by vendor and by agent; a partial index keeps those scans cheap
-- without weighing on the DECISION-receipt hot path.
CREATE INDEX IF NOT EXISTS receipts_verify_vendor_idx
  ON receipts (vendor_id) WHERE kind = 'VERIFY';
CREATE INDEX IF NOT EXISTS receipts_agent_idx
  ON receipts (agent_id, created_at);
