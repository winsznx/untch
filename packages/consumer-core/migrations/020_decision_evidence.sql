-- Decision evidence V2: content hashes where V1 had pointers.
--
-- WHAT A POINTER COSTS
--
-- A V1 decision recorded `policyId` and `policyVersion`. Both point at a row that can be updated, so
-- the answer to "what was this judged against" changes when the policy changes. It recorded no quote
-- digest, so an approval and the thing it approved were connected only by timing. And it recorded no
-- evaluator, so two decisions under one anchored ruleset could disagree with nothing explaining why —
-- which has already happened here, when `hardCap.absolute` began being enforced for a policy
-- registered before that rule existed.
--
-- Every one of those is fixed by storing content and hashing it, rather than naming where it lives.
--
-- WHY THE SNAPSHOT IS ITS OWN TABLE
--
-- It is content-addressed and append-only. One policy evaluated a hundred times writes one snapshot
-- row and a hundred decisions referencing it, so the storage cost is per DISTINCT state rather than
-- per decision. And because the key IS the hash, an update would have to change the key, which is
-- what makes "historical decisions do not change when the current policy changes" a property of the
-- schema instead of a promise in a comment.

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutable policy snapshots
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_policy_snapshots (
  -- keccak256 over the RFC 8785 canonical form of `snapshot`. The primary key IS the content.
  snapshot_hash TEXT PRIMARY KEY,

  -- Denormalised for querying without parsing the JSON. They are part of `snapshot` too, and the
  -- hash covers the JSON, so these can never be authoritative — they are an index, not a record.
  policy_id     TEXT        NOT NULL,
  policy_hash   TEXT        NOT NULL,
  owner         TEXT        NOT NULL,
  chain_id      INTEGER     NOT NULL,

  -- The complete decision-time state, canonicalised. This is what the hash commits to.
  snapshot      JSONB       NOT NULL,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_policy_snapshot_hash_shape CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS untch_policy_snapshots_policy ON untch_policy_snapshots (policy_id, first_seen_at DESC);

/*
 * Immutability, enforced rather than intended.
 *
 * A content-addressed table where rows can be UPDATEd is not content-addressed: the hash would stop
 * describing the row and every decision pointing at it would silently change meaning. The trigger is
 * the mechanism because a convention is not one — nothing stops a later migration, a console session
 * or a well-meaning repair script from issuing an UPDATE.
 */
CREATE OR REPLACE FUNCTION untch_policy_snapshots_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'untch_policy_snapshots is append-only: a snapshot is addressed by its own hash, so '
    'changing a row would make every decision that references it describe something that never existed. '
    'Write a new snapshot instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_policy_snapshots_no_update ON untch_policy_snapshots;
CREATE TRIGGER untch_policy_snapshots_no_update
  BEFORE UPDATE OR DELETE ON untch_policy_snapshots
  FOR EACH ROW EXECUTE FUNCTION untch_policy_snapshots_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- Decision evidence
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_decision_evidence (
  decision_id             TEXT PRIMARY KEY,
  intent_id               TEXT        NOT NULL,
  intent_hash             TEXT        NOT NULL,

  -- PRIVATE. Never rendered in a public projection. A receipt is public and an accountId is durable
  -- across every receipt an account produces, so publishing it would let anyone assemble a stranger's
  -- whole spending history from public data.
  account_id              TEXT,
  -- PUBLIC. keccak256("untch-account-reference-v1" || accountId), domain-separated so it cannot be
  -- computed from, or replayed as, a hash of the same id in any other context.
  account_ref_hash        TEXT,

  policy_id               TEXT        NOT NULL,
  policy_hash             TEXT,
  policy_snapshot_hash    TEXT        REFERENCES untch_policy_snapshots(snapshot_hash),

  quote_digest            TEXT,

  engine_version          TEXT,
  rule_manifest_hash      TEXT,

  decision                TEXT        NOT NULL,
  rule_trace              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at            TIMESTAMPTZ NOT NULL,

  metadata_schema_version INTEGER     NOT NULL DEFAULT 1,

  -- 'V2_COMPLETE' | 'LEGACY_PARTIAL'. A backfill that cannot recover a field leaves it null and says
  -- so here, rather than writing a plausible value to make an old row look whole. An invented value
  -- is worse than a gap: the gap is visible.
  completeness            TEXT        NOT NULL DEFAULT 'LEGACY_PARTIAL',

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_decision_completeness_known
    CHECK (completeness IN ('V2_COMPLETE', 'LEGACY_PARTIAL')),

  /*
   * The invariant, in the database.
   *
   * A V2 row missing any required field would be indistinguishable from a complete one to every later
   * reader, which is exactly the failure the version number exists to prevent. The store guards this
   * too; the constraint holds for anything that reaches the table by another path, and a migration
   * script is such a path.
   */
  CONSTRAINT untch_decision_v2_is_complete CHECK (
    metadata_schema_version <> 2
    OR (
      account_id IS NOT NULL
      AND account_ref_hash IS NOT NULL
      AND policy_hash IS NOT NULL
      AND policy_snapshot_hash IS NOT NULL
      AND quote_digest IS NOT NULL
      AND engine_version IS NOT NULL
      AND rule_manifest_hash IS NOT NULL
      AND completeness = 'V2_COMPLETE'
    )
  ),

  -- The converse: a row claiming completeness must be a V2 row. Without this, `LEGACY_PARTIAL` and
  -- `V2_COMPLETE` could disagree with the version and neither would be trustworthy.
  CONSTRAINT untch_decision_complete_implies_v2 CHECK (
    completeness <> 'V2_COMPLETE' OR metadata_schema_version = 2
  )
);

CREATE INDEX IF NOT EXISTS untch_decision_evidence_intent ON untch_decision_evidence (intent_id);
CREATE INDEX IF NOT EXISTS untch_decision_evidence_account ON untch_decision_evidence (account_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS untch_decision_evidence_quote ON untch_decision_evidence (quote_digest);
-- The supersession query: every decision sharing a quote lineage, newest first.
CREATE INDEX IF NOT EXISTS untch_decision_evidence_policy ON untch_decision_evidence (policy_id, evaluated_at DESC);
