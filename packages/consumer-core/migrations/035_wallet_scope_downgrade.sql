-- ═════════════════════════════════════════════════════════════════════════════
-- Removing authority is its own operation, asked for and signed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT WENT WRONG
--
-- `linkWallet` upserted `scopes = EXCLUDED.scopes`. A relink that asked for `["identity"]` — because a
-- caller wrote `scopes` where the route reads `requestedScopes`, and the server defaulted — silently
-- stripped `policy-authority` from an ACTIVE binding. The account kept its wallet and quietly lost the
-- authority to approve a payment. Nothing recorded that it had happened, because from the schema's
-- point of view nothing unusual had.
--
-- The relink path now UNIONS, so proving you hold a wallet can add authority and can never remove it.
-- That leaves a real need unserved: sometimes an owner genuinely wants less authority on a binding.
-- This table is that operation.
--
-- WHY A SIGNED CHALLENGE RATHER THAN A SESSION
--
-- A session proves somebody was authenticated at some point in the last hour. Reducing authority is
-- exactly the operation an attacker performs with a borrowed session — quietly, once, before doing
-- anything else — so it asks for a fresh signature from the wallet whose authority is being reduced,
-- against a nonce this table issued and will accept exactly once.
--
-- WHY THE ROW IS IMMUTABLE
--
-- It is the only record that authority was deliberately reduced rather than lost. If it could be
-- edited or deleted, the difference between "the owner asked for this" and "something narrowed it
-- again" would be unrecoverable — which is precisely the ambiguity the original defect created.

CREATE TABLE IF NOT EXISTS untch_wallet_scope_downgrades (
  downgrade_id      TEXT        PRIMARY KEY,

  -- The challenge nonce, single-use. A replayed downgrade presents a nonce this row already spent.
  challenge_nonce   TEXT        NOT NULL UNIQUE,

  account_id        TEXT        NOT NULL,
  binding_id        TEXT        NOT NULL,
  address           TEXT        NOT NULL,

  -- What the authority WAS and what it BECAME. Both, because "removed policy-approval" is only
  -- meaningful beside what was held at the time.
  scopes_before     TEXT[]      NOT NULL,
  scopes_after      TEXT[]      NOT NULL,
  scopes_removed    TEXT[]      NOT NULL,

  -- The signature that authorised it, and the message it signed. Kept so the reduction can be
  -- re-verified later against the address, rather than believed because a row exists.
  proof_ref         TEXT        NOT NULL,
  challenge_digest  TEXT        NOT NULL,

  issued_at         TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by        TEXT        NOT NULL,

  CONSTRAINT untch_downgrade_dated        CHECK (expires_at > issued_at),
  -- Identity is what attaches the wallet to the account. A downgrade reduces what the binding may DO;
  -- it is not a way to detach a wallet, and a request to remove identity is a different operation that
  -- does not exist. Refused here so no handler can be the only thing standing in the way.
  CONSTRAINT untch_downgrade_keeps_identity CHECK ('identity' = ANY(scopes_after)),
  -- A downgrade that removed nothing is a no-op somebody believed was a change.
  CONSTRAINT untch_downgrade_removes_something CHECK (array_length(scopes_removed, 1) >= 1)
);

CREATE INDEX IF NOT EXISTS untch_wallet_scope_downgrades_binding
  ON untch_wallet_scope_downgrades (binding_id, applied_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- The record cannot be rewritten
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION untch_downgrade_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'untch_wallet_scope_downgrades: % is an audit record of a reduction that happened; it cannot be % ',
    COALESCE(OLD.downgrade_id, NEW.downgrade_id), lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_downgrade_immutable ON untch_wallet_scope_downgrades;
CREATE TRIGGER untch_downgrade_immutable
  BEFORE UPDATE OR DELETE ON untch_wallet_scope_downgrades
  FOR EACH ROW EXECUTE FUNCTION untch_downgrade_is_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- The challenge that authorises one reduction
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Separate from the audit row because it exists BEFORE the reduction and may never be redeemed. Its
-- nonce is the primary key, so two concurrent completions of one challenge cannot both proceed — the
-- second is refused by the database rather than by whichever handler read first.
CREATE TABLE IF NOT EXISTS untch_wallet_scope_challenges (
  challenge_nonce   TEXT        PRIMARY KEY,
  account_id        TEXT        NOT NULL,
  binding_id        TEXT        NOT NULL,
  -- The EXACT final scope set the signer is being asked to authorise. Stored server-side so the
  -- completion cannot present a different set than the one the message described.
  scopes_after      TEXT[]      NOT NULL,
  message           TEXT        NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,

  CONSTRAINT untch_scope_challenge_dated CHECK (expires_at > issued_at),
  CONSTRAINT untch_scope_challenge_keeps_identity CHECK ('identity' = ANY(scopes_after))
);

CREATE INDEX IF NOT EXISTS untch_wallet_scope_challenges_expiry
  ON untch_wallet_scope_challenges (expires_at);
