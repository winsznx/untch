-- ═════════════════════════════════════════════════════════════════════════════
-- One OAuth round trip, usable once
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THE CALLBACK PATH STOPPED CARRYING THE REFERENCE
--
-- The action callback used to be `/consumer/approvals/action/:actionReferenceId/return`, which cannot
-- work: Discord matches `redirect_uri` against a REGISTERED, exact string, and a per-reference path is
-- a different string every time. A deployment could register only one of them, so every real round trip
-- would have come back to a reference that was not the one the person opened.
--
-- The fix is a single fixed callback, with the reference travelling in `state` instead. That moves the
-- reference out of the URL Discord has to know about, and into a value the server signs.
--
-- WHY A SIGNED STATE IS NOT SUFFICIENT ON ITS OWN
--
-- A signature proves the server minted the value. It does not prove the value has not been REPLAYED.
-- The callback is a GET; a browser back button, a refresh, a shared URL out of a chat log, or a proxy
-- retry all present the same signed state a second time, and every one of them would produce another
-- authenticated actor session for an action the person may already have answered.
--
-- So the nonce inside the state is spent HERE, in a table with a primary key, and the spend is what
-- makes the round trip single-use. An INSERT that violates the key is a replay, which is a refusal
-- rather than an error: the database decides, not a read-then-write in the handler that two concurrent
-- callbacks could both pass.
--
-- WHY THIS ROW IS NOT FINANCIAL STATE
--
-- It records that an authentication happened, and nothing about money. The callback that writes it
-- creates no ApprovalDecision, consumes no action nonce, creates no BudgetReservation and moves no
-- request between states. The start link stays completely inert — it writes nothing at all, because it
-- is the URL that sits in a chat message where crawlers and prefetchers will reach it.

CREATE TABLE IF NOT EXISTS untch_approval_oauth_states (
  -- The nonce from inside the signed state. Primary key, so the second presentation of one round trip
  -- is refused by the database rather than by whichever handler happened to look first.
  state_nonce           TEXT        PRIMARY KEY,

  -- What the state was minted FOR. A state signed for one purpose must not be redeemable at another
  -- surface that happens to share the signing secret.
  purpose               TEXT        NOT NULL,

  -- What the state claims, kept so a redeemed round trip can be audited against the reference it named
  -- rather than only against the cookie it produced.
  action_reference_id   TEXT        NOT NULL,
  channel_binding_id    TEXT        NOT NULL,
  action                TEXT        NOT NULL,

  issued_at             TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The Discord subject the exchange returned. Recorded because "who completed this round trip" is the
  -- question an incident asks first, and the cookie that carries it is gone in ten minutes.
  subject               TEXT,

  CONSTRAINT untch_oauth_state_purpose_known CHECK (purpose IN ('approval_action_v1')),
  CONSTRAINT untch_oauth_state_action_known  CHECK (action IN ('APPROVE', 'DENY')),
  CONSTRAINT untch_oauth_state_dated         CHECK (expires_at > issued_at)
);

-- Expiry sweeps read by time; nothing reads this table by reference in a hot path.
CREATE INDEX IF NOT EXISTS untch_approval_oauth_states_expiry
  ON untch_approval_oauth_states (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- A spent round trip cannot be un-spent
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The row exists only to say "this nonce is gone". Allowing it to be deleted or re-dated would restore
-- the replay it was written to prevent, and no correct code path has any reason to do either.
CREATE OR REPLACE FUNCTION untch_oauth_state_is_final() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at > now() THEN
    RAISE EXCEPTION
      'untch_approval_oauth_states: % is spent and has not expired; it cannot be deleted', OLD.state_nonce;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'untch_approval_oauth_states: % is spent; a spent OAuth state cannot be rewritten', OLD.state_nonce;
  END IF;
  RETURN COALESCE(OLD, NEW);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_oauth_state_final ON untch_approval_oauth_states;
CREATE TRIGGER untch_oauth_state_final
  BEFORE UPDATE OR DELETE ON untch_approval_oauth_states
  FOR EACH ROW EXECUTE FUNCTION untch_oauth_state_is_final();
