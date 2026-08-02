-- An audit annotation for rows that are not policies, and a rule about how snapshots may be read.
--
-- WHY THIS EXISTS
--
-- Verifying migration 020's immutability trigger required inserting a row into
-- `untch_policy_snapshots` in production, then attempting to UPDATE it. The trigger refused, which is
-- the correct result — and the probe row remains, because the table is append-only by design and
-- deleting it would require the very capability the trigger exists to deny.
--
-- The row is harmless and it is also a row in a table whose other rows are real policy states. The
-- risk is not the row; it is a future query that treats `SELECT * FROM untch_policy_snapshots` as a
-- list of policies. So the annotation records what the row is, and the comment below records the
-- reading rule that makes the distinction structural rather than remembered.

CREATE TABLE IF NOT EXISTS untch_snapshot_annotations (
  snapshot_hash   TEXT PRIMARY KEY REFERENCES untch_policy_snapshots(snapshot_hash),
  classification  TEXT        NOT NULL,
  created_during  TEXT        NOT NULL,
  referenced      BOOLEAN     NOT NULL DEFAULT false,
  production_impact TEXT      NOT NULL,
  note            TEXT        NOT NULL,
  annotated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_snapshot_annotation_class
    CHECK (classification IN ('TEST_PROBE_ORPHAN', 'SUPERSEDED', 'IMPORTED'))
);

/*
 * THE READING RULE.
 *
 * A policy snapshot is reachable in exactly two ways: through a decision that references it, or by an
 * explicit snapshot hash somebody already holds. It is never reachable by enumerating the table.
 *
 * `untch_policy_snapshots` is a content-addressed archive of states that were once observed. A row in
 * it means "this state existed at some point", not "this is a policy". An account's policies come
 * from `untch_account_policies`; the default comes from `untch_accounts.default_policy_id`; a
 * decision's snapshot comes from `untch_decision_evidence.policy_snapshot_hash`. None of those is a
 * scan of this table, and none of them can see an unreferenced row.
 */
COMMENT ON TABLE untch_policy_snapshots IS
  'Content-addressed archive of observed policy states. Reachable ONLY through a decision reference or an explicit hash. Never enumerate this table as a list of policies: a row means a state existed, not that it is a policy.';

INSERT INTO untch_snapshot_annotations
  (snapshot_hash, classification, created_during, referenced, production_impact, note)
SELECT
  s.snapshot_hash,
  'TEST_PROBE_ORPHAN',
  'migration 020 verification',
  false,
  'none',
  'Inserted to prove the append-only trigger refuses an UPDATE. The trigger refused, which is why the row cannot be removed. Referenced by no decision and unreachable through any business query.'
FROM untch_policy_snapshots s
WHERE s.snapshot_hash = '0xabababababababababababababababababababababababababababababababab'
  AND NOT EXISTS (SELECT 1 FROM untch_decision_evidence d WHERE d.policy_snapshot_hash = s.snapshot_hash)
ON CONFLICT (snapshot_hash) DO NOTHING;
