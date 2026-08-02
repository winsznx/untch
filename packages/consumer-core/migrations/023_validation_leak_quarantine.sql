-- The 2026-08-02 validation leak, classified.
--
-- The mechanism is receipt-writer's 022_artifact_audit_annotation.sql. This file is the incident: the
-- ten rows a rolled-back validation left behind, and the two escalation views that apply the
-- classification to the escalation tables.
--
-- WHY THE ESCALATION VIEWS ARE HERE AND NOT IN 022
--
-- 022 lives with the tables it guards. `escalations` belongs to the escalation package, whose own
-- migrations stop at 004 — adding a fifth there would renumber into territory receipt-writer already
-- used. Consumer-core migrates last at boot, so this is the first file that can see every table it
-- needs.
--
-- WHY EVERY STATEMENT IS GUARDED BY to_regclass
--
-- This is the first consumer-core migration to reach across package boundaries, and consumer-core's
-- runner applies ONLY this package's files. Several suites — the activity index, accounts, account
-- linking — build a consumer-core-only schema, where `receipts`, `escalations` and the annotation
-- table itself do not exist. An unguarded reference does not fail this migration in isolation; it
-- fails every one of those suites in their `before` hook, which is how a quarantine for one leak
-- becomes an outage in the suites that would catch the next one. It did exactly that when this file
-- was first written.
--
-- The guard is also the honest semantics rather than a workaround: a schema with no `receipts` table
-- never had the incident, so there is nothing there to classify. Production runs receipt-writer's
-- migrations before consumer-core's at boot, so production takes every branch below.

DO $$
BEGIN
  IF to_regclass('public.untch_artifact_annotations') IS NULL THEN
    RAISE NOTICE '023: no untch_artifact_annotations (receipt-writer 022 has not run in this schema) — nothing to classify';
    RETURN;
  END IF;

  -- ── The escalation surfaces ────────────────────────────────────────────────────────────────────
  IF to_regclass('public.escalations') IS NOT NULL THEN
    EXECUTE $v$
      CREATE OR REPLACE VIEW escalations_business AS
        SELECT e.* FROM escalations e
         WHERE NOT EXISTS (
           SELECT 1 FROM untch_artifact_annotations a
            WHERE a.artifact_kind = 'ESCALATION' AND a.artifact_ref = e.id
              AND a.eligible_for_business_metrics = false)
    $v$;
    EXECUTE $v$
      CREATE OR REPLACE VIEW escalations_audit AS
        SELECT e.*, (a.artifact_ref IS NOT NULL) AS quarantined,
               a.classification AS quarantine_classification, a.note AS quarantine_note
          FROM escalations e
          LEFT JOIN untch_artifact_annotations a
            ON a.artifact_kind = 'ESCALATION' AND a.artifact_ref = e.id
    $v$;
  END IF;

  -- ── The receipts ───────────────────────────────────────────────────────────────────────────────
  --
  -- Selected FROM the artifact table rather than listed as literals, so a database that never saw the
  -- incident acquires nothing. These three are the shadow of a decision that has no record: the
  -- evidence transaction rolled back correctly and `untch_decision_evidence` stayed empty.
  IF to_regclass('public.receipts') IS NOT NULL THEN
    INSERT INTO untch_artifact_annotations
      (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
       eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
       eligible_for_business_metrics, note)
    SELECT 'RECEIPT', r.receipt_id, 'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK',
           'internal preflight validation', false, false, false, false, false, false,
           'Enqueued by /internal/consumer/preflight-validate on 2026-08-02 while its receipt enqueuer '
           'still acted on the pool rather than the caller''s rolled-back transaction. No payment funded '
           'it, no provider ran, and its decision evidence was correctly rolled back — so this row is the '
           'shadow of a decision that has no record. Never anchor it and never count it.'
      FROM receipts r
     WHERE r.receipt_id IN (
       '0x5306d6231b9e9343415e0fd2b4b48a218937a87192dc0f2ab2e60eed88bd898c',
       '0xbb9b292b6eef8377e5e2a3a44050d9299ade74e6222972980bb7bb1a0289b061',
       '0x0d1ffa05b4ba585b274296d5c463760c911bf44acc4cf59f761bb482c486d44c')
    ON CONFLICT (artifact_kind, artifact_ref) DO NOTHING;
  END IF;

  -- ── The batch ──────────────────────────────────────────────────────────────────────────────────
  --
  -- Annotated only if it holds nothing BUT the leaked receipts. A batch that had also picked up real
  -- work must not be quarantined wholesale — that would suppress a real receipt to contain a fake one.
  IF to_regclass('public.batches') IS NOT NULL AND to_regclass('public.receipts') IS NOT NULL THEN
    INSERT INTO untch_artifact_annotations
      (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
       eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
       eligible_for_business_metrics, note)
    SELECT 'RECEIPT_BATCH', b.id, 'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK',
           'internal preflight validation', false, false, false, false, false, false,
           'Holds only the three leaked receipts. Its ten anchoring attempts were refused on-chain by '
           'logReceipts (0x5d94d23c); that refusal was luck and the trigger in 022 is the design.'
      FROM batches b
     WHERE b.id = '28'
       AND EXISTS (SELECT 1 FROM receipts r WHERE r.batch_id = b.id)
       AND NOT EXISTS (
         SELECT 1 FROM receipts r
          WHERE r.batch_id = b.id
            AND r.receipt_id NOT IN (
              '0x5306d6231b9e9343415e0fd2b4b48a218937a87192dc0f2ab2e60eed88bd898c',
              '0xbb9b292b6eef8377e5e2a3a44050d9299ade74e6222972980bb7bb1a0289b061',
              '0x0d1ffa05b4ba585b274296d5c463760c911bf44acc4cf59f761bb482c486d44c'))
    ON CONFLICT (artifact_kind, artifact_ref) DO NOTHING;
  END IF;

  -- ── The ledger entries ─────────────────────────────────────────────────────────────────────────
  --
  -- The part that would have become money: one SPEND of 4.00 USDT0 and two BLOCK_SAVED, all on
  -- day_key 2026-08-02, none of them backed by a payment.
  IF to_regclass('public.ledger_entries') IS NOT NULL THEN
    INSERT INTO untch_artifact_annotations
      (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
       eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
       eligible_for_business_metrics, note)
    SELECT 'LEDGER_ENTRY', l.id::text, 'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK',
           'internal preflight validation', false, false, false, false, false, false,
           'Written alongside a leaked receipt by the same rolled-back validation run. A SPEND that no '
           'wallet funded and a saving that nothing was saved from; counting either would put invented '
           'money in a report.'
      FROM ledger_entries l
     WHERE l.receipt_id IN (
       '0x5306d6231b9e9343415e0fd2b4b48a218937a87192dc0f2ab2e60eed88bd898c',
       '0xbb9b292b6eef8377e5e2a3a44050d9299ade74e6222972980bb7bb1a0289b061',
       '0x0d1ffa05b4ba585b274296d5c463760c911bf44acc4cf59f761bb482c486d44c')
    ON CONFLICT (artifact_kind, artifact_ref) DO NOTHING;
  END IF;

  -- ── The escalation that reached a person ───────────────────────────────────────────────────────
  --
  -- It stays APPROVED because that is what happened. What it is NOT is a decision anyone paid for.
  IF to_regclass('public.escalations') IS NOT NULL THEN
    INSERT INTO untch_artifact_annotations
      (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
       eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
       eligible_for_business_metrics, note)
    SELECT 'ESCALATION', e.id, 'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK',
           'internal preflight validation', false, false, false, false, false, false,
           'Raised at 15:27:40.060Z by a validation run that rolled back, and delivered to real Telegram, '
           'Discord and Slack. A person approved it on Discord at 15:29:10 and two later Telegram clicks '
           'were correctly refused as IGNORED_ALREADY_RESOLVED. The approval is real and the thing it '
           'approved never existed: no quote was paid and no provider ran.'
      FROM escalations e
     WHERE e.id = 'esc_44c567b949fe'
    ON CONFLICT (artifact_kind, artifact_ref) DO NOTHING;
  END IF;

  -- ── The operator and its binding ───────────────────────────────────────────────────────────────
  --
  -- Auto-created by the same run, 13ms before the fanout. They are NOT the user's account-scoped
  -- channel authority: that lives in untch_channel_bindings and is deliberately still empty.
  IF to_regclass('public.escalation_operators') IS NOT NULL THEN
    INSERT INTO untch_artifact_annotations
      (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
       eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
       eligible_for_business_metrics, note)
    SELECT 'ESCALATION_OPERATOR', o.id, 'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK',
           'internal preflight validation', false, false, false, false, false, false,
           'Auto-created at 15:27:40.047Z by the leaked validation run. It is a legacy escalation operator '
           'derived from a policy owner address, not an account-scoped channel binding, and must never be '
           'presented as one: acct_yuznzh6w4a6cvljlskas3nvmdc has no verified channel binding.'
      FROM escalation_operators o
     WHERE o.id = 'op:0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64'
    ON CONFLICT (artifact_kind, artifact_ref) DO NOTHING;
  END IF;

  IF to_regclass('public.escalation_operator_bindings') IS NOT NULL THEN
    INSERT INTO untch_artifact_annotations
      (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
       eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
       eligible_for_business_metrics, note)
    SELECT 'ESCALATION_OPERATOR_BINDING', b.operator_id || ':' || b.channel,
           'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK', 'internal preflight validation',
           false, false, false, false, false, false,
           'The dashboard binding auto-created with the leaked operator. Not a proof of channel control '
           'and not an account-owned binding.'
      FROM escalation_operator_bindings b
     WHERE b.operator_id = 'op:0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64'
       AND b.channel = 'dashboard'
    ON CONFLICT (artifact_kind, artifact_ref) DO NOTHING;
  END IF;
END $$;
