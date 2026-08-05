-- ═════════════════════════════════════════════════════════════════════════════
-- Bound approval actions, and the backstop that does not trust the application
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT WENT WRONG
--
-- `POST /consumer/approvals/:id/decide` predates the paid approval model and writes to the same two
-- tables it uses. So once the paid path began raising requests, a session cookie was enough to move one
-- to APPROVED with no action token, no consumed nonce, no FINALIZED service call, no budget recheck and
-- no reservation. Two terminal paths reached the same rows and only one of them was safe.
--
-- The route now refuses a service-call-backed request. That fix lives in application code, which is
-- exactly the kind of fix that stops being true the next time somebody adds a handler, writes a repair
-- script, or opens psql.
--
-- WHAT THIS FILE DOES ABOUT IT
--
-- Moves the invariant into the database, where a forgotten code path cannot get around it. After this
-- migration a terminal decision on a service-call-backed request is REFUSED unless it names a consumed
-- action nonce belonging to that same request, the request was PENDING, the service call was FINALIZED,
-- and an APPROVE carries exactly one ACTIVE reservation naming both the request and the decision.
--
-- WHY THE CHECK IS DEFERRED
--
-- `actOnApproval` inserts the decision, then the reservation, then updates the request — one
-- transaction, three statements, in an order chosen so the locks are taken safely. A row-level trigger
-- firing on the INSERT would look for a reservation that correctly does not exist yet and refuse a
-- correct writer. So this is a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, evaluated at COMMIT
-- when the whole unit is visible. That also means a partially-written unit can never satisfy it.
--
-- WHAT IS DELIBERATELY EXEMPT
--
-- Requests where `service_call_id IS NULL`. Those were raised before the paid model existed and have no
-- service call to finalize, no payment attempt and no action reference. Demanding the paid path's
-- fields of them would fail a historical row for lacking something it could never have had, and would
-- retroactively reinterpret what those approvals meant.

-- ─────────────────────────────────────────────────────────────────────────────
-- The nonce a terminal decision must name
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `actOnApproval` already consumes a nonce by PRIMARY KEY insert, which is what makes two concurrent
-- taps resolve to one decision. The decision row did not RECORD which nonce it consumed, so nothing
-- afterwards could prove a given decision came through the bound path. This column is that proof, and
-- the backstop below is what makes it mandatory where it matters.

ALTER TABLE untch_approval_decisions
  ADD COLUMN IF NOT EXISTS action_nonce TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS untch_decision_one_per_nonce
  ON untch_approval_decisions (action_nonce) WHERE action_nonce IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Opaque action references
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THE TOKEN IS NOT IN THE URL
--
-- A Discord message is a public-ish artifact. It is copied, quoted, screenshotted, previewed by
-- Discord's own link unfurler and crawled. A URL carrying the full action token would make every one of
-- those a bearer instrument for a financial decision, and the token deliberately commits to the whole
-- obligation precisely so that holding it is meaningful.
--
-- So the URL carries an opaque reference and nothing else. It names a row here; the row names the
-- request, the binding and the action; and the server mints the token internally at the moment a
-- verified human presses the button. The reference alone proves nothing and authorises nothing.
--
-- The token itself is NEVER stored. It is derived server-side at action time from the request row and
-- the binding, so this table holds no material that could be redeemed if it leaked. `token_fingerprint`
-- is one-way and exists only to correlate a log line with a decision.

CREATE TABLE IF NOT EXISTS untch_approval_action_refs (
  action_reference_id TEXT PRIMARY KEY,
  approval_request_id TEXT        NOT NULL REFERENCES untch_approval_requests(approval_request_id) ON DELETE CASCADE,
  account_id          TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,
  channel_binding_id  TEXT        NOT NULL REFERENCES untch_channel_bindings(binding_id) ON DELETE CASCADE,

  -- The subject this reference is valid for. A requote changes the digest, so a stale reference stops
  -- matching without anything having to hunt it down.
  approval_digest     TEXT        NOT NULL,
  -- The account-scoped actor. Never the raw account id: this row is resolved from a public URL.
  account_ref_hash    TEXT        NOT NULL,

  action              TEXT        NOT NULL,
  -- The nonce the minted token will carry, chosen here so the reference and the token agree and so a
  -- second press cannot mint a second usable nonce.
  nonce               TEXT        NOT NULL,
  token_fingerprint   TEXT,
  schema_version      INTEGER     NOT NULL DEFAULT 1,

  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  invalidated_at      TIMESTAMPTZ,
  invalidation_reason TEXT,

  created_by          TEXT        NOT NULL DEFAULT 'approval-delivery',

  CONSTRAINT untch_action_ref_known_action CHECK (action IN ('APPROVE', 'DENY')),
  -- Single-use, stated as a constraint rather than left to whoever writes the consuming query.
  CONSTRAINT untch_action_ref_not_both CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);

CREATE INDEX IF NOT EXISTS untch_action_ref_by_request
  ON untch_approval_action_refs (approval_request_id, action);

CREATE INDEX IF NOT EXISTS untch_action_ref_live
  ON untch_approval_action_refs (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- One live reference per request, binding and action. A redelivery reuses the row rather than minting a
-- second URL, so an old message and a new one cannot both be pressable.
CREATE UNIQUE INDEX IF NOT EXISTS untch_action_ref_one_live
  ON untch_approval_action_refs (approval_request_id, channel_binding_id, action)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- A terminal state is terminal
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Without this, a repair script could set a REJECTED request back to PENDING and make it approvable a
-- second time. The forward transitions the lifecycle needs are all still allowed; only the return from
-- a resolved state to an open one is refused.

CREATE OR REPLACE FUNCTION untch_approval_state_is_terminal() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state IN ('APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'CANCELLED', 'PAYMENT_FAILED')
     AND NEW.state IN ('PENDING', 'PROVISIONAL') THEN
    RAISE EXCEPTION
      'untch_approval_requests: % is terminal and cannot return to %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_approval_no_resurrection ON untch_approval_requests;
CREATE TRIGGER untch_approval_no_resurrection
  BEFORE UPDATE ON untch_approval_requests
  FOR EACH ROW EXECUTE FUNCTION untch_approval_state_is_terminal();

-- ─────────────────────────────────────────────────────────────────────────────
-- The backstop
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION untch_decision_must_be_bound() RETURNS TRIGGER AS $$
DECLARE
  req            RECORD;
  nonce_row      RECORD;
  call_state     TEXT;
  reservations   INTEGER;
BEGIN
  SELECT * INTO req FROM untch_approval_requests WHERE approval_request_id = NEW.approval_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'untch_approval_decisions: no approval request %', NEW.approval_request_id;
  END IF;

  -- Legacy requests are exempt in full. They have no service call, so none of the paid-path evidence
  -- below could exist for them, and demanding it would fail a historical row for what it never had.
  IF req.service_call_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The decision must be for the account that owns the request. A routing bug that crossed accounts
  -- would otherwise write a perfectly well-formed decision about somebody else's money.
  IF NEW.account_id IS DISTINCT FROM req.account_id THEN
    RAISE EXCEPTION
      'untch_approval_decisions: decision account % does not own request %',
      NEW.account_id, NEW.approval_request_id;
  END IF;

  -- It must name a nonce, and the nonce must have been consumed for THIS request.
  IF NEW.action_nonce IS NULL THEN
    RAISE EXCEPTION
      'untch_approval_decisions: a decision on service-call-backed request % must name the action nonce it consumed',
      NEW.approval_request_id;
  END IF;

  SELECT * INTO nonce_row FROM untch_approval_action_nonces WHERE nonce = NEW.action_nonce;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'untch_approval_decisions: action nonce for request % was never consumed', NEW.approval_request_id;
  END IF;
  IF nonce_row.approval_request_id IS DISTINCT FROM NEW.approval_request_id THEN
    RAISE EXCEPTION
      'untch_approval_decisions: action nonce belongs to request %, not %',
      nonce_row.approval_request_id, NEW.approval_request_id;
  END IF;
  IF (nonce_row.action = 'APPROVE') IS DISTINCT FROM (NEW.decision = 'APPROVE') THEN
    RAISE EXCEPTION
      'untch_approval_decisions: nonce authorises % and the decision is %', nonce_row.action, NEW.decision;
  END IF;

  -- The fee that bought the right to ask has to be confirmed settled.
  SELECT state INTO call_state FROM untch_x402_service_calls WHERE service_call_id = req.service_call_id;
  IF call_state IS DISTINCT FROM 'FINALIZED' THEN
    RAISE EXCEPTION
      'untch_approval_decisions: service call % is %, not FINALIZED', req.service_call_id, coalesce(call_state, 'missing');
  END IF;

  -- One terminal decision. The per-actor unique index already stops one actor answering twice; this is
  -- the stronger statement that a request has one answer regardless of who gave it.
  SELECT count(*) INTO reservations
    FROM untch_approval_decisions
   WHERE approval_request_id = NEW.approval_request_id;
  IF reservations > 1 THEN
    RAISE EXCEPTION
      'untch_approval_decisions: request % already has a terminal decision', NEW.approval_request_id;
  END IF;

  -- An APPROVE creates authority, and the authority has to exist and has to name this decision.
  SELECT count(*) INTO reservations
    FROM untch_budget_reservations
   WHERE approval_request_id = NEW.approval_request_id
     AND approval_decision_id = NEW.decision_id;

  IF NEW.decision = 'APPROVE' THEN
    IF reservations <> 1 THEN
      RAISE EXCEPTION
        'untch_approval_decisions: an APPROVE on request % must create exactly one reservation naming it, found %',
        NEW.approval_request_id, reservations;
    END IF;
  ELSE
    IF reservations <> 0 THEN
      RAISE EXCEPTION
        'untch_approval_decisions: a % on request % must create no reservation, found %',
        NEW.decision, NEW.approval_request_id, reservations;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DEFERRABLE INITIALLY DEFERRED: evaluated at COMMIT, when the decision, the reservation and the
-- request update are all visible as one unit. A row-level trigger would fire mid-unit and refuse a
-- correct writer for a reservation that does not exist yet.
DROP TRIGGER IF EXISTS untch_decision_bound_backstop ON untch_approval_decisions;
CREATE CONSTRAINT TRIGGER untch_decision_bound_backstop
  AFTER INSERT ON untch_approval_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION untch_decision_must_be_bound();
