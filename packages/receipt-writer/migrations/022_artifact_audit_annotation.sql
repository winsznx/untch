-- A generic, append-only audit annotation for artifacts that exist and must never be read as truth.
--
-- WHY THIS EXISTS
--
-- On 2026-08-02 at 15:27:37–15:27:42Z the internal validation route
-- `/internal/consumer/preflight-validate` ran `handlePublicPreflight` inside a transaction that always
-- rolls back, but passed `preflightEngineDeps()` through unchanged. The escalation gateway and the
-- receipt enqueuer act on the connection POOL, not on the caller's transaction, so the rollback that
-- correctly erased the evidence rows did not erase anything they wrote. That run left behind:
--
--   • three DECISION receipts (4.00 / 6.00 / 9.00 USDT0) in batch 28
--   • three ledger_entries — one SPEND and two BLOCK_SAVED — against day_key 2026-08-02
--   • escalation esc_44c567b949fe, which paged a real person on Telegram, Discord and Slack
--   • operator op:0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64 and its dashboard binding
--
-- #61 removed the dependencies so it cannot happen again. This migration is about the rows that
-- already exist. They are NOT deleted and NOT rewritten: deleting evidence of a defect is how the
-- defect gets rediscovered, and the ledger is append-only for the same reason receipts are.
--
-- THIS FILE IS THE MECHANISM, NOT THE INCIDENT
--
-- It lives with `receipts`, `batches` and `ledger_entries` because those are the tables it guards, and
-- because receipt-writer migrates before consumer-core at boot — so the table exists before anything
-- annotates a row in it. The annotations for the 2026-08-02 leak are consumer-core's
-- 023_validation_leak_quarantine.sql. A future incident is a new migration, never an edit to this one.
--
-- WHY AN ANNOTATION TABLE RATHER THAN A COLUMN
--
-- A `quarantined` column on `receipts` would be one boolean per table, added again on `ledger_entries`,
-- again on `escalations`, and forgotten on the fourth table. It would also be UPDATEable, which means
-- the record of what happened could be edited by the same class of mistake that produced it. One
-- append-only table addressed by (kind, ref) covers every artifact type including ones not yet built,
-- and carries the six eligibility answers a reader actually needs.
--
-- WHY VIEWS RATHER THAN A RULE EVERY QUERY REMEMBERS
--
-- Migration 021 established the reading rule for snapshots as a comment and a test, because a snapshot
-- is only ever reached by a reference. These rows are different: `receipts` and `ledger_entries` ARE
-- enumerated — that is what a report, a score and a revenue total do. A convention that every future
-- SELECT must add a NOT EXISTS clause is a convention that will be broken. So the business surface
-- gets its own name, already filtered, and the unfiltered table keeps the raw truth for the audit view.

-- ─────────────────────────────────────────────────────────────────────────────
-- The annotation
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_artifact_annotations (
  artifact_kind  TEXT        NOT NULL,
  artifact_ref   TEXT        NOT NULL,
  classification TEXT        NOT NULL,
  source         TEXT        NOT NULL,

  -- The six answers. They are separate because they are separately true: a leaked receipt is
  -- ineligible for all six, whereas a superseded-but-real receipt would still be eligible for
  -- accounting. Collapsing them into one `quarantined` flag would force that distinction to be
  -- re-derived by every reader, differently.
  paid                          BOOLEAN NOT NULL,
  provider_executed             BOOLEAN NOT NULL,
  eligible_for_anchoring        BOOLEAN NOT NULL,
  eligible_for_accounting       BOOLEAN NOT NULL,
  eligible_for_public_proof     BOOLEAN NOT NULL,
  eligible_for_business_metrics BOOLEAN NOT NULL,

  note           TEXT        NOT NULL,
  annotated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (artifact_kind, artifact_ref),

  CONSTRAINT untch_artifact_annotation_kind CHECK (artifact_kind IN (
    'RECEIPT', 'RECEIPT_BATCH', 'LEDGER_ENTRY', 'ESCALATION',
    'ESCALATION_OPERATOR', 'ESCALATION_OPERATOR_BINDING',
    'DECISION_EVIDENCE', 'APPROVAL_REQUEST', 'ACTIVITY_CASE', 'SERVICE_ORDER'
  )),

  CONSTRAINT untch_artifact_annotation_class CHECK (classification IN (
    'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK', 'TEST_PROBE_ORPHAN', 'SUPERSEDED', 'IMPORTED'
  )),

  -- An artifact that was not paid for and executed no provider cannot be eligible for anchoring,
  -- accounting, public proof or business metrics. Stated as a constraint so a future annotation
  -- cannot quietly assert a combination that has no meaning.
  CONSTRAINT untch_artifact_annotation_coherent CHECK (
    (paid OR provider_executed)
    OR NOT (eligible_for_anchoring OR eligible_for_accounting
            OR eligible_for_public_proof OR eligible_for_business_metrics)
  )
);

CREATE INDEX IF NOT EXISTS untch_artifact_annotations_class
  ON untch_artifact_annotations (classification, annotated_at DESC);

/*
 * Append-only, enforced.
 *
 * This table is the record of what a defect did. If it can be UPDATEd or DELETEd then the record of
 * the mistake is editable by the next mistake, and a quarantine becomes something an incident can
 * lift on its own behalf. Correcting an annotation means annotating a new artifact, or superseding
 * this one in a migration that says so in its own text.
 */
CREATE OR REPLACE FUNCTION untch_artifact_annotations_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'untch_artifact_annotations is append-only: it records what an artifact IS, and a '
    'quarantine that can be lifted by an UPDATE is not a quarantine. Add a new annotation instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_artifact_annotations_no_update ON untch_artifact_annotations;
CREATE TRIGGER untch_artifact_annotations_no_update
  BEFORE UPDATE OR DELETE ON untch_artifact_annotations
  FOR EACH ROW EXECUTE FUNCTION untch_artifact_annotations_immutable();

COMMENT ON TABLE untch_artifact_annotations IS
  'Append-only classification for rows that exist but must not be read as business truth. Addressed by (artifact_kind, artifact_ref). Business and public surfaces read the *_business / *_public views, which apply it; the *_audit views show every row with the annotation attached.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Anchoring, refused at the table rather than remembered by the worker
-- ─────────────────────────────────────────────────────────────────────────────

/*
 * The three leaked receipts sit in batch 28, whose ten anchoring attempts were refused by the
 * contract itself (`logReceipts` reverted 0x5d94d23c). That refusal is luck, not design — the batch
 * is one operator re-drive away from being retried as split singles.
 *
 * "Never anchored" therefore has to be a property of the row, not a rule the anchorer follows. An
 * anchored receipt is a public claim that work happened; for these rows that claim would be false.
 */
CREATE OR REPLACE FUNCTION untch_receipts_refuse_quarantined_anchor() RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash)
     OR (NEW.block_number IS NOT NULL AND NEW.block_number IS DISTINCT FROM OLD.block_number)
     OR (NEW.status = 'CONFIRMED' AND OLD.status IS DISTINCT FROM 'CONFIRMED')
  THEN
    IF EXISTS (
      SELECT 1 FROM untch_artifact_annotations a
       WHERE a.artifact_kind = 'RECEIPT'
         AND a.artifact_ref = NEW.receipt_id
         AND a.eligible_for_anchoring = false
    ) THEN
      RAISE EXCEPTION 'receipt % is annotated ineligible for anchoring: anchoring it would publish a '
        'claim that work happened when it did not. See untch_artifact_annotations.', NEW.receipt_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_receipts_no_quarantined_anchor ON receipts;
CREATE TRIGGER untch_receipts_no_quarantined_anchor
  BEFORE UPDATE ON receipts
  FOR EACH ROW EXECUTE FUNCTION untch_receipts_refuse_quarantined_anchor();

/*
 * A batch is anchored as a unit, so a batch holding an unanchorable receipt is itself unanchorable.
 * Guarding only the receipt would let the batch reach SUBMITTED and fail halfway, which is a worse
 * state than refusing at the start.
 */
CREATE OR REPLACE FUNCTION untch_batches_refuse_quarantined_anchor() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('SUBMITTED', 'CONFIRMED') AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF EXISTS (
      SELECT 1
        FROM receipts r
        JOIN untch_artifact_annotations a
          ON a.artifact_kind = 'RECEIPT' AND a.artifact_ref = r.receipt_id
       WHERE r.batch_id = NEW.id
         AND a.eligible_for_anchoring = false
    ) THEN
      RAISE EXCEPTION 'batch % contains a receipt annotated ineligible for anchoring and cannot be '
        'submitted. Re-drive the anchorable receipts in a new batch.', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_batches_no_quarantined_anchor ON batches;
CREATE TRIGGER untch_batches_no_quarantined_anchor
  BEFORE UPDATE ON batches
  FOR EACH ROW EXECUTE FUNCTION untch_batches_refuse_quarantined_anchor();

-- ─────────────────────────────────────────────────────────────────────────────
-- The surfaces
-- ─────────────────────────────────────────────────────────────────────────────

-- Each view filters on the ONE flag that governs it. A single `quarantined` predicate would exclude a
-- superseded-but-real receipt from accounting, which is a different and wrong answer.

CREATE OR REPLACE VIEW receipts_business AS
  SELECT r.* FROM receipts r
   WHERE NOT EXISTS (
     SELECT 1 FROM untch_artifact_annotations a
      WHERE a.artifact_kind = 'RECEIPT' AND a.artifact_ref = r.receipt_id
        AND a.eligible_for_business_metrics = false);

CREATE OR REPLACE VIEW receipts_public AS
  SELECT r.* FROM receipts r
   WHERE NOT EXISTS (
     SELECT 1 FROM untch_artifact_annotations a
      WHERE a.artifact_kind = 'RECEIPT' AND a.artifact_ref = r.receipt_id
        AND a.eligible_for_public_proof = false);

CREATE OR REPLACE VIEW ledger_entries_business AS
  SELECT l.* FROM ledger_entries l
   WHERE NOT EXISTS (
     SELECT 1 FROM untch_artifact_annotations a
      WHERE a.artifact_kind = 'LEDGER_ENTRY' AND a.artifact_ref = l.id::text
        AND a.eligible_for_accounting = false)
     AND NOT EXISTS (
     SELECT 1 FROM untch_artifact_annotations a
      WHERE a.artifact_kind = 'RECEIPT' AND a.artifact_ref = l.receipt_id
        AND a.eligible_for_accounting = false);

-- The audit views keep every row and attach the reason, so an operator sees the artifact AND the
-- warning in one read. A surface that shows the row without the annotation is how a leak gets
-- mistaken for history.

CREATE OR REPLACE VIEW receipts_audit AS
  SELECT r.*, (a.artifact_ref IS NOT NULL) AS quarantined,
         a.classification AS quarantine_classification, a.note AS quarantine_note,
         a.paid AS quarantine_paid, a.provider_executed AS quarantine_provider_executed
    FROM receipts r
    LEFT JOIN untch_artifact_annotations a
      ON a.artifact_kind = 'RECEIPT' AND a.artifact_ref = r.receipt_id;

CREATE OR REPLACE VIEW ledger_entries_audit AS
  SELECT l.*, (a.artifact_ref IS NOT NULL) AS quarantined,
         a.classification AS quarantine_classification, a.note AS quarantine_note
    FROM ledger_entries l
    LEFT JOIN untch_artifact_annotations a
      ON a.artifact_kind = 'LEDGER_ENTRY' AND a.artifact_ref = l.id::text;
