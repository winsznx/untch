-- Decision evidence V3: the requester the deployed struct has nowhere to put.
--
-- WHAT V2 RECORDED, AND THE ONE THING IT COULD NOT SAY
--
-- V2 replaced every pointer with a content hash and made a decision reproducible. It still could not
-- answer WHO ASKED, because `SpendIntent` has eleven fields and none of them names an account
-- (docs/adr/ADR-replace-legacy-buyerAgentId-with-requester-principal.md). A direct Untch-account
-- request is anchored with `buyerAgentId = 0` — the reserved protocol null meaning NO MARKETPLACE
-- BUYER EXISTS — and the same zero, under V1 or V2, means a decision receipted against an agent that
-- does not exist. Same bytes, opposite meanings. Only the record can tell them apart, so the record
-- has to say it.
--
-- WHY THIS EXTENDS THE TABLE INSTEAD OF ADDING A SECOND ONE
--
-- A decision is a decision. Two tables would mean two answers to "what has this account decided", two
-- indexes to keep in step, and one forgotten join away from a report that omits every V2 row while
-- looking complete. So V3 is additive columns, and every V3-specific rule is a CHECK — because an
-- application-only rule is a rule a repair script bypasses, and this file is what a repair script
-- still has to get past.
--
-- NOTHING IS BACKFILLED
--
-- A V1 or V2 row has no requester principal because it genuinely did not record one. Writing
-- `untch_account` into it would assert a fact nobody established, which is worse than the gap: the
-- gap is visible. Every column below is nullable for exactly that reason, and the CHECK constraints
-- require them only when `metadata_schema_version = 3`.

ALTER TABLE untch_decision_evidence
  -- ── who asked ─────────────────────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS requester_principal_kind      TEXT,
  -- Which authority the reference is scoped to. The field whose ABSENCE makes a bare uint256
  -- insufficient: `6047` is not an identity until you say which registry issued it.
  ADD COLUMN IF NOT EXISTS requester_principal_namespace TEXT,
  ADD COLUMN IF NOT EXISTS requester_principal_ref       TEXT,
  -- PUBLIC. A domain-separated hash of the wallet AUTHORITY STATE — address, binding, proof kind and
  -- the moment it was proven. Reactivating a revoked binding writes a fresh proof, so this changes,
  -- so an approval created under the old authority matches nothing afterwards.
  ADD COLUMN IF NOT EXISTS wallet_authority_ref          TEXT,
  -- PRIVATE. Resolvable only in an authenticated view, like account_id.
  ADD COLUMN IF NOT EXISTS wallet_binding_id             TEXT,

  -- ── the legacy field, and what it meant here ──────────────────────────────
  ADD COLUMN IF NOT EXISTS onchain_buyer_agent_id        TEXT,
  ADD COLUMN IF NOT EXISTS buyer_agent_id_semantics      TEXT,
  -- The marketplace buyer, when one exists. NULL for a direct account — not 0, because 0 is the
  -- on-chain encoding of "there is none" and this column is where that distinction is kept honest.
  ADD COLUMN IF NOT EXISTS buyer_agent_id                TEXT,
  ADD COLUMN IF NOT EXISTS marketplace                   TEXT,
  ADD COLUMN IF NOT EXISTS marketplace_binding_id        TEXT,

  -- ── who is transacted with, and who does the work ─────────────────────────
  -- Two columns, currently both '6086'. They are different ROLES: the ASP being transacted with, and
  -- the agent performing the work. A deployment where Untch brokers somebody else's service makes
  -- them different values, and collapsing them now because they match is how a role gets borrowed.
  ADD COLUMN IF NOT EXISTS seller_asp_id                 TEXT,
  ADD COLUMN IF NOT EXISTS worker_agent_id               TEXT,
  ADD COLUMN IF NOT EXISTS service_id                    TEXT,

  -- ── the policy, in more detail than the chain can hold ────────────────────
  ADD COLUMN IF NOT EXISTS policy_owner                  TEXT,
  ADD COLUMN IF NOT EXISTS governed_agent                TEXT,
  -- The disclosure that travels with every V3 row: the chain commits the RULESET hash, this record
  -- commits the exact policy id, and the deployed contract cannot tell two policies apart when they
  -- share an owner and a ruleset. Stated, so no reader infers a stronger on-chain identity than exists.
  ADD COLUMN IF NOT EXISTS policy_selection_semantics    TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- The completeness vocabulary gains a third word
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_completeness_known;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_completeness_known
  CHECK (completeness IN ('V2_COMPLETE', 'V3_COMPLETE', 'LEGACY_PARTIAL'));

-- The old constraint said "complete implies V2". That is now one of two cases, and stating it as one
-- rule keeps a row from claiming a completeness its version does not support.
ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_complete_implies_v2;
ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_completeness_matches_version;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_completeness_matches_version CHECK (
    (completeness <> 'V2_COMPLETE' OR metadata_schema_version = 2)
    AND (completeness <> 'V3_COMPLETE' OR metadata_schema_version = 3)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- A V3 row is complete or it is not written
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_v3_is_complete;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_v3_is_complete CHECK (
    metadata_schema_version <> 3
    OR (
      account_id IS NOT NULL
      AND account_ref_hash IS NOT NULL
      AND wallet_binding_id IS NOT NULL
      AND wallet_authority_ref IS NOT NULL
      AND requester_principal_kind IS NOT NULL
      AND requester_principal_namespace IS NOT NULL
      AND requester_principal_ref IS NOT NULL
      AND onchain_buyer_agent_id IS NOT NULL
      AND buyer_agent_id_semantics IS NOT NULL
      AND seller_asp_id IS NOT NULL
      AND worker_agent_id IS NOT NULL
      AND service_id IS NOT NULL
      AND policy_hash IS NOT NULL
      AND policy_owner IS NOT NULL
      AND governed_agent IS NOT NULL
      AND policy_snapshot_hash IS NOT NULL
      AND policy_selection_semantics IS NOT NULL
      AND quote_digest IS NOT NULL
      AND engine_version IS NOT NULL
      AND rule_manifest_hash IS NOT NULL
      AND completeness = 'V3_COMPLETE'
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- A direct account request has no marketplace in it. At all.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every clause here is a way a row could otherwise claim an authority it does not hold. A direct
-- decision carrying a nonzero buyerAgentId would be receipted against a marketplace agent that had no
-- part in it; one carrying a marketplace binding id would attach a decision to a relationship it was
-- not made through, and every downstream reader would inherit the association.

ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_v3_direct_account_shape;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_v3_direct_account_shape CHECK (
    metadata_schema_version <> 3
    OR requester_principal_kind <> 'untch_account'
    OR (
      onchain_buyer_agent_id = '0'
      AND buyer_agent_id IS NULL
      AND marketplace IS NULL
      AND marketplace_binding_id IS NULL
      AND buyer_agent_id_semantics = 'no_marketplace_buyer'
      AND requester_principal_namespace = 'untch-account'
      -- The reference IS the accountRefHash. A second public reference to one requester would leave a
      -- verifier asking which of them the quote digest bound, and that question has no good answer.
      AND requester_principal_ref = account_ref_hash
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- A marketplace request names the agent that made it, and proves it
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_v3_marketplace_shape;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_v3_marketplace_shape CHECK (
    metadata_schema_version <> 3
    OR requester_principal_kind <> 'marketplace_agent'
    OR (
      onchain_buyer_agent_id ~ '^[1-9][0-9]*$'
      AND buyer_agent_id = onchain_buyer_agent_id
      AND marketplace IS NOT NULL
      AND marketplace_binding_id IS NOT NULL
      AND buyer_agent_id_semantics = 'verified_marketplace_agent'
      AND requester_principal_namespace <> 'untch-account'
      AND requester_principal_ref = requester_principal_namespace || ':' || buyer_agent_id
    )
  );

-- Only two kinds exist. A third would be a third proof obligation, and adding one by INSERT rather
-- than by migration is how a path with no proof acquires a name.
ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_v3_requester_kind_known;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_v3_requester_kind_known CHECK (
    requester_principal_kind IS NULL
    OR requester_principal_kind IN ('untch_account', 'marketplace_agent')
  );

ALTER TABLE untch_decision_evidence DROP CONSTRAINT IF EXISTS untch_decision_v3_onchain_buyer_is_uint;
ALTER TABLE untch_decision_evidence
  ADD CONSTRAINT untch_decision_v3_onchain_buyer_is_uint CHECK (
    onchain_buyer_agent_id IS NULL OR onchain_buyer_agent_id ~ '^(0|[1-9][0-9]*)$'
  );

CREATE INDEX IF NOT EXISTS untch_decision_evidence_requester
  ON untch_decision_evidence (requester_principal_ref, evaluated_at DESC);

COMMENT ON COLUMN untch_decision_evidence.onchain_buyer_agent_id IS
  'The uint256 written into SpendIntent.buyerAgentId. ''0'' on a direct account request is the reserved protocol null meaning NO MARKETPLACE BUYER EXISTS — it is NOT ERC-8004 agent 0, and it must never be rendered as an agent id. Under metadata_schema_version 1 or 2 a zero means something else entirely: a decision receipted against an agent that does not exist. Read buyer_agent_id_semantics, never the number alone.';

COMMENT ON COLUMN untch_decision_evidence.policy_selection_semantics IS
  'exact_offchain_policy_id_legacy_onchain_policy_hash — the legacy on-chain SpendIntent commits the policy RULESET hash; this row commits the exact selected policy_id. The deployed contract cannot independently distinguish two policies that share an owner and a policyHash.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Approvals commit the requester too
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The approval digest already binds these values; these columns make the binding legible without
-- recomputing a hash, and let a query answer "which approvals were raised under the wallet authority
-- that has since been revoked". Nullable, because approvals raised before V3 did not record them and
-- their v1 digests are still valid over exactly what they hashed.

ALTER TABLE untch_approval_requests
  ADD COLUMN IF NOT EXISTS requester_principal_kind      TEXT,
  ADD COLUMN IF NOT EXISTS requester_principal_namespace TEXT,
  ADD COLUMN IF NOT EXISTS requester_principal_ref       TEXT,
  ADD COLUMN IF NOT EXISTS account_ref_hash              TEXT,
  ADD COLUMN IF NOT EXISTS wallet_authority_ref          TEXT,
  ADD COLUMN IF NOT EXISTS quote_digest                  TEXT;

ALTER TABLE untch_approval_decisions
  ADD COLUMN IF NOT EXISTS requester_principal_kind      TEXT,
  ADD COLUMN IF NOT EXISTS requester_principal_ref       TEXT,
  ADD COLUMN IF NOT EXISTS wallet_authority_ref          TEXT;

CREATE INDEX IF NOT EXISTS untch_approval_requests_requester
  ON untch_approval_requests (requester_principal_ref, created_at DESC);
