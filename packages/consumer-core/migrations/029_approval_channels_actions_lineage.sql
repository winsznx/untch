-- Who may answer, how they are asked, and what happens when the quote changes.
--
-- WHAT 016 ALREADY GOT RIGHT, AND IS NOT BEING REPLACED
--
-- `untch_channel_bindings` already separates `can_decide` from the row's existence, so an email binding
-- can receive an approval and never answer one. It already holds one active platform identity per
-- channel, so a Telegram user cannot decide for two accounts. Both properties are kept exactly.
--
-- WHAT WAS MISSING
--
-- A binding could decide or not. There was no way to say WHAT it could decide, which is the difference
-- between "this Telegram account is yours" and "this Telegram account may commit your money". The
-- approval path needs the second claim to be separate and explicit, for the same reason `identity` and
-- `policy-authority` are separate on a wallet: proving where you can be reached is not the same
-- permission as approving a payment.
--
-- The rest is the machinery a terminal decision needs to be safe: a nonce ledger so an action token is
-- single-use, a delivery lifecycle that can be invalidated in one statement, and quote lineage so a
-- requote supersedes rather than accumulates.

-- ─────────────────────────────────────────────────────────────────────────────
-- Channel bindings gain scopes, a fuller lifecycle, and their proof
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_channel_bindings
  ADD COLUMN IF NOT EXISTS scopes             TEXT[] NOT NULL DEFAULT ARRAY['notify']::TEXT[],
  ADD COLUMN IF NOT EXISTS account_ref_hash   TEXT,
  -- How the external identity was proven. 'link_code_callback' for Telegram and Discord, where the
  -- platform hands us a verified user id on the callback. 'account_session' for web, where the proof
  -- is the SIWE-derived session itself.
  ADD COLUMN IF NOT EXISTS verification_method TEXT,
  -- What was consumed to create it. Kept so a binding can be traced to its link request without the
  -- request holding anything that could recreate the token.
  ADD COLUMN IF NOT EXISTS proof_ref          TEXT,
  -- A Discord guild, a Slack workspace, a Telegram chat. Null for a direct message.
  ADD COLUMN IF NOT EXISTS workspace_ref      TEXT,
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by      TEXT;

ALTER TABLE untch_channel_bindings DROP CONSTRAINT IF EXISTS untch_channel_status_known;
ALTER TABLE untch_channel_bindings ADD CONSTRAINT untch_channel_status_known
  CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED', 'SUPERSEDED'));

-- 'web' joins the known channels. It is a real binding rather than a special case in code, so the
-- operator-identity checks a Telegram action passes are the same ones a browser action passes.
ALTER TABLE untch_channel_bindings DROP CONSTRAINT IF EXISTS untch_channel_known;
ALTER TABLE untch_channel_bindings ADD CONSTRAINT untch_channel_known
  CHECK (channel IN ('telegram', 'discord', 'email', 'dashboard', 'web', 'slack'));

-- THE SCOPE THAT COMMITS MONEY.
--
-- `policy-approval` is what lets a channel identity answer a financial approval. A binding that can
-- decide must hold it, so `can_decide` cannot drift away from what the scopes actually say — the two
-- were free to disagree before, and a disagreement here is an authority bug.
ALTER TABLE untch_channel_bindings DROP CONSTRAINT IF EXISTS untch_channel_decider_scoped;
ALTER TABLE untch_channel_bindings ADD CONSTRAINT untch_channel_decider_scoped
  CHECK (can_decide = false OR 'policy-approval' = ANY(scopes));

-- Slack is delivery-only until its approval identity is properly proven. Stated in the schema rather
-- than remembered by whoever writes the next adapter.
ALTER TABLE untch_channel_bindings DROP CONSTRAINT IF EXISTS untch_channel_slack_cannot_decide;
ALTER TABLE untch_channel_bindings ADD CONSTRAINT untch_channel_slack_cannot_decide
  CHECK (channel <> 'slack' OR can_decide = false);

-- The one-active-identity index from 016 counted only ACTIVE. PENDING is also live, in the sense that
-- two pending links for one Telegram user would race to become the active one.
DROP INDEX IF EXISTS untch_channel_one_active_identity;
CREATE UNIQUE INDEX IF NOT EXISTS untch_channel_one_active_identity
  ON untch_channel_bindings (channel, channel_user_id)
  WHERE status IN ('PENDING', 'ACTIVE');

-- ─────────────────────────────────────────────────────────────────────────────
-- Link tokens carry scope and channel, not just an account
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_channel_bind_codes
  ADD COLUMN IF NOT EXISTS requested_scopes TEXT[] NOT NULL DEFAULT ARRAY['notify']::TEXT[],
  ADD COLUMN IF NOT EXISTS nonce            TEXT,
  ADD COLUMN IF NOT EXISTS account_ref_hash TEXT,
  -- Only ever a fingerprint. The raw token is never written, so a database dump cannot be redeemed.
  ADD COLUMN IF NOT EXISTS token_fingerprint TEXT;

ALTER TABLE untch_channel_bind_codes DROP CONSTRAINT IF EXISTS untch_channel_code_channel_known;
ALTER TABLE untch_channel_bind_codes ADD CONSTRAINT untch_channel_code_channel_known
  CHECK (channel IN ('telegram', 'discord', 'email', 'web', 'slack'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Deliveries gain a lifecycle that can be invalidated
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 017's deliveries recorded an ATTEMPT: sent, skipped or failed. That answers "was anybody told". It
-- cannot answer "can this message still be acted on", which is the question that matters once a
-- message carries a button. After one terminal decision every sibling has to stop being actionable in
-- the same transaction, and a row with no state to move cannot express that.

ALTER TABLE untch_approval_deliveries
  ADD COLUMN IF NOT EXISTS account_id         TEXT REFERENCES untch_accounts(account_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS status             TEXT NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN IF NOT EXISTS external_delivery_id TEXT,
  -- The family of action tokens this message carried. Invalidating the delivery invalidates them all
  -- without the row ever holding a token.
  ADD COLUMN IF NOT EXISTS action_token_family TEXT,
  ADD COLUMN IF NOT EXISTS attempts           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sent_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_code       TEXT;

-- Decisions may now arrive from 'web'. 017 listed the channels a decision could come from and 'web'
-- did not exist yet, so an authenticated browser approval would have been refused by the CHECK rather
-- than by any authority rule.
ALTER TABLE untch_approval_decisions DROP CONSTRAINT IF EXISTS untch_decision_channel_known;
ALTER TABLE untch_approval_decisions ADD CONSTRAINT untch_decision_channel_known
  CHECK (channel IN ('dashboard', 'telegram', 'discord', 'email', 'operator', 'web'));

ALTER TABLE untch_approval_deliveries DROP CONSTRAINT IF EXISTS untch_delivery_status_known;
ALTER TABLE untch_approval_deliveries ADD CONSTRAINT untch_delivery_status_known
  CHECK (status IN (
    'QUEUED', 'SENDING', 'SENT', 'DELIVERED',
    'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'ACTED', 'INVALIDATED', 'EXPIRED'
  ));

-- ONE logical delivery per request and binding. A worker that retries updates this row rather than
-- inserting a second, so a retry storm cannot become a message storm.
CREATE UNIQUE INDEX IF NOT EXISTS untch_delivery_one_per_request_binding
  ON untch_approval_deliveries (approval_request_id, channel_binding_id)
  WHERE channel_binding_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS untch_delivery_claimable
  ON untch_approval_deliveries (status, next_attempt_at)
  WHERE status IN ('QUEUED', 'FAILED_RETRYABLE');

-- A delivery and its binding must belong to the same account. Enforced rather than joined, because a
-- cross-account delivery is how one person's approval reaches another person's phone.
CREATE OR REPLACE FUNCTION untch_delivery_same_account() RETURNS TRIGGER AS $$
DECLARE
  binding_account TEXT;
  request_account TEXT;
BEGIN
  IF NEW.channel_binding_id IS NULL THEN RETURN NEW; END IF;
  SELECT account_id INTO binding_account FROM untch_channel_bindings WHERE binding_id = NEW.channel_binding_id;
  SELECT account_id INTO request_account FROM untch_approval_requests WHERE approval_request_id = NEW.approval_request_id;
  IF binding_account IS NULL THEN
    RAISE EXCEPTION 'channel binding % does not exist', NEW.channel_binding_id;
  END IF;
  IF binding_account IS DISTINCT FROM request_account THEN
    RAISE EXCEPTION 'delivery would send account % approval to a channel bound to account %',
      request_account, binding_account;
  END IF;
  IF NEW.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM request_account THEN
    RAISE EXCEPTION 'delivery account does not match its request account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_delivery_same_account_trg ON untch_approval_deliveries;
CREATE TRIGGER untch_delivery_same_account_trg
  BEFORE INSERT OR UPDATE ON untch_approval_deliveries
  FOR EACH ROW EXECUTE FUNCTION untch_delivery_same_account();

-- ─────────────────────────────────────────────────────────────────────────────
-- Action nonces: single-use, enforced by a primary key
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A token is single-use because consuming it INSERTS here and the second insert collides. Not because
-- a handler checked a flag first: two concurrent taps on the same button would both pass that check.

CREATE TABLE IF NOT EXISTS untch_approval_action_nonces (
  nonce               TEXT PRIMARY KEY,
  approval_request_id TEXT        NOT NULL REFERENCES untch_approval_requests(approval_request_id) ON DELETE CASCADE,
  channel_binding_id  TEXT,
  action              TEXT        NOT NULL,
  consumed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_action_known CHECK (action IN ('APPROVE', 'DENY'))
);

CREATE INDEX IF NOT EXISTS untch_action_nonce_by_request
  ON untch_approval_action_nonces (approval_request_id, consumed_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Quote lineage
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A requote is not a new unrelated request and it is not the same request with a different number. It
-- is a SUCCESSOR, and saying so explicitly is what lets the old authority be retired in the same
-- transaction the new one is created.

ALTER TABLE untch_approval_requests
  ADD COLUMN IF NOT EXISTS quote_lineage_id              TEXT,
  ADD COLUMN IF NOT EXISTS previous_quote_digest         TEXT,
  ADD COLUMN IF NOT EXISTS supersedes_approval_request_id TEXT,
  ADD COLUMN IF NOT EXISTS supersedes_reservation_id     TEXT,
  ADD COLUMN IF NOT EXISTS superseded_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersession_reason           TEXT;

CREATE INDEX IF NOT EXISTS untch_approval_by_lineage
  ON untch_approval_requests (quote_lineage_id, created_at DESC)
  WHERE quote_lineage_id IS NOT NULL;

-- ONE active successor per lineage. Two would mean a lineage where both 6.50 and 6.75 were live and
-- either could be approved, which is the accumulation this whole concept exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_open_per_lineage
  ON untch_approval_requests (quote_lineage_id)
  WHERE quote_lineage_id IS NOT NULL AND state IN ('PROVISIONAL', 'PENDING');

-- ─────────────────────────────────────────────────────────────────────────────
-- Reservations learn where their authority came from
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_budget_reservations
  ADD COLUMN IF NOT EXISTS approval_request_id  TEXT REFERENCES untch_approval_requests(approval_request_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS approval_decision_id TEXT,
  ADD COLUMN IF NOT EXISTS quote_lineage_id     TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by_reservation_id TEXT;

-- ONE reservation per approved request. An approval buys exactly one authority.
CREATE UNIQUE INDEX IF NOT EXISTS untch_reservation_one_per_approval
  ON untch_budget_reservations (approval_request_id)
  WHERE approval_request_id IS NOT NULL;

COMMENT ON COLUMN untch_channel_bindings.scopes IS
  'notify allows a message to arrive. policy-approval allows an answer to commit money. Separate for the same reason a wallet separates identity from policy-authority: being reachable is not permission to spend.';

COMMENT ON TABLE untch_approval_action_nonces IS
  'Single-use action tokens, enforced by the PRIMARY KEY rather than by a check-then-write. Two concurrent taps on one button both pass a flag check; only one can insert here.';
