-- The durable one-shot Solana proof claim.
--
-- WHY A TABLE AND NOT AN INFERENCE
--
-- The first version of this gate inferred consumption from the execution rows: if no execution for
-- the proof intent had reached PAID or ACKNOWLEDGED, the gate was considered unused. That is wrong,
-- and wrong in the direction that costs money.
--
-- Between the signer being invoked and PAID being persisted there are five distinct moments: the
-- credential is constructed, the transaction is signed, it is handed to a sponsor, the sponsor
-- broadcasts, and only then does anything of ours get written. A crash anywhere in that sequence
-- leaves an execution row that does NOT say PAID while a real transfer may already be on chain. An
-- inference from the final state therefore reports "unused" for a gate that has already spent, and
-- the next attempt pays twice.
--
-- So the claim is taken BEFORE the signer is reachable, and it is taken here, in a row, under a
-- conditional write. The question the gate must answer is not "did this succeed?" but "might the
-- treasury's authority already have been used?", and only a record written beforehand can answer
-- that after a crash.
--
-- THE STATES
--
--   ARMED               scope exists, signer never reached
--   CLAIMED             one worker won the right to sign; the signer may have been reached
--   SETTLED             a confirmed Solana transaction exists
--   ACKNOWLEDGED        the provider returned the paid result
--   MANUAL_REVIEW       signing or broadcast may have happened and settlement cannot be disproven
--   RELEASED_PRE_SIGN   proven that no credential, signature or broadcast was ever created
--
-- CLAIMED is deliberately a ONE-WAY DOOR for automation. Nothing moves a CLAIMED row back to ARMED,
-- because "the attempt failed" and "no money moved" are different claims and only the second one
-- justifies re-arming. RELEASED_PRE_SIGN exists for the case where the second can actually be shown,
-- and reaching it requires evidence rather than a FAILED execution row: a FAILED row is exactly what
-- an ambiguous broadcast also produces.

CREATE TABLE IF NOT EXISTS consumer_solana_proof_gate (
  -- The scope hash is the primary key, so ONE scope can exist at most once. Two workers arming the
  -- same proof converge on the same row rather than creating two gates that each look unclaimed.
  scope_hash            TEXT PRIMARY KEY,

  state                 TEXT NOT NULL,

  -- The exact authorised scope. Stored rather than only compared, so an operator reading this row
  -- later can see what was authorised without reconstructing it from environment variables that have
  -- since been removed.
  intent_id             TEXT NOT NULL,
  provider_id           TEXT NOT NULL,
  capability            TEXT NOT NULL,
  chain                 TEXT NOT NULL,
  asset_symbol          TEXT NOT NULL,
  asset_address         TEXT,
  max_amount            TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,

  -- Who claimed it, and when. The execution id ties the claim to the worker attempt that holds it.
  claimed_by_execution  TEXT,
  claimed_at            TIMESTAMPTZ,

  -- Signer evidence. `signer_reached_at` is the field that makes release decidable: once it is set,
  -- automatic release is forbidden regardless of how the attempt ended.
  signer_reached_at     TIMESTAMPTZ,
  credential_created_at TIMESTAMPTZ,

  -- Settlement evidence, written as early as each piece becomes known rather than in one batch at
  -- the end. A signature persisted before the provider is retried is the difference between a
  -- recoverable ambiguity and an unanswerable one.
  tx_signature          TEXT,
  tx_submitted_at       TIMESTAMPTZ,
  settled_at            TIMESTAMPTZ,
  confirmed_slot        BIGINT,
  tx_error              TEXT,
  pre_token_amount      TEXT,
  post_token_amount     TEXT,
  token_delta           TEXT,
  mint                  TEXT,
  authority             TEXT,
  fee_payer             TEXT,

  acknowledged_at       TIMESTAMPTZ,
  provider_result_hash  TEXT,

  manual_review_reason  TEXT,
  released_at           TIMESTAMPTZ,
  released_reason       TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT consumer_solana_proof_gate_state_check CHECK (
    state IN ('ARMED', 'CLAIMED', 'SETTLED', 'ACKNOWLEDGED', 'MANUAL_REVIEW', 'RELEASED_PRE_SIGN')
  ),

  -- A claimed-or-later row must name its claimant. Without this a row could reach CLAIMED with no
  -- record of who holds it, which is the same as not being claimed at all.
  CONSTRAINT consumer_solana_proof_gate_claim_check CHECK (
    state = 'ARMED'
    OR state = 'RELEASED_PRE_SIGN'
    OR (claimed_by_execution IS NOT NULL AND claimed_at IS NOT NULL)
  ),

  -- Release requires proving the signer was never reached. Enforced in the database as well as in
  -- code, because this is the one transition that can turn a spent gate back into a spendable one.
  CONSTRAINT consumer_solana_proof_gate_release_check CHECK (
    state <> 'RELEASED_PRE_SIGN'
    OR (signer_reached_at IS NULL AND credential_created_at IS NULL AND tx_signature IS NULL)
  )
);

-- One ARMED or CLAIMED gate per intent at a time. Two live gates for one intent would let a second
-- attempt claim a "fresh" gate while the first is still in flight.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_solana_proof_gate_live_intent
  ON consumer_solana_proof_gate (intent_id)
  WHERE state IN ('ARMED', 'CLAIMED');
