-- The gap between "a fee was charged" and "a human was asked".
--
-- WHY THIS MIGRATION EXISTS
--
-- `docs/architecture/x402-settlement-lifecycle.md` established, by reading the installed package
-- rather than its documentation, that the business handler's transaction commits BEFORE
-- `processSettlement` runs. A handler that inserted an actionable approval row would therefore be
-- promising a human's attention before knowing the service fee was paid, and a settlement failure
-- afterwards leaves that promise committed.
--
-- `docs/architecture/approval-settlement-boundary.md` then established something sharper:
--
--     processSettlement returns success:true for BOTH "success" AND "pending".
--
-- A `pending` settlement is one the facilitator accepted and has not confirmed on chain. It produces
-- real settlement headers and a 2xx that is byte-indistinguishable from a confirmed one. So the
-- middleware's success boolean, the settlement header, and the HTTP status are all evidence that a
-- transfer was ACCEPTED, and none of them is evidence that it CONFIRMED.
--
-- Everything below follows from those two facts:
--
--   • an approval that a human may act on is a state a handler cannot reach, only a finalizer holding
--     authoritative settlement evidence can
--   • the identity a settlement is matched by (the EIP-3009 nonce) is not the identity a retry is
--     matched by (the service call), so they are separate columns in separate tables
--   • a settled service call must be resolvable WITHOUT running the payment middleware again, because
--     the middleware settles on any 2xx and no constraint here can undo an on-chain transfer
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not enable anything. `APPROVAL_PATH_READY` remains false and the public account route
-- continues to refuse escalations with 503. These tables exist so the foundation can be built and
-- proven behind that gate, not so it can be switched on.

-- ─────────────────────────────────────────────────────────────────────────────
-- The service call: one requested Untch service, stable across retries
-- ─────────────────────────────────────────────────────────────────────────────
--
-- NOT to be confused with `untch_decision_service_calls`, which already exists and is a per-service
-- COOLDOWN CLOCK keyed by (partition_key, service_host). It has nothing to do with payment. Reusing
-- that name would have put the payment lifecycle in the same semantic type as rate limiting.

CREATE TABLE IF NOT EXISTS untch_x402_service_calls (
  service_call_id     TEXT PRIMARY KEY,

  account_id          TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,
  -- The route as mounted, so two priced routes cannot share an idempotency key.
  route               TEXT        NOT NULL,
  -- What the CLIENT called it. Their key, echoed, never trusted alone.
  idempotency_key     TEXT        NOT NULL,
  -- What the SERVER derived from the request body. A client that reuses a key for different terms
  -- must not resolve to the earlier call, and this is the column that notices.
  request_fingerprint TEXT        NOT NULL,

  -- Requester identity, carried so a service call can be attributed without joining an approval.
  requester_principal_kind TEXT,
  requester_principal_ref  TEXT,
  account_ref_hash         TEXT,
  wallet_authority_ref     TEXT,

  -- The policy selection this call was evaluated under, and the decision it produced.
  policy_id           TEXT,
  policy_hash         TEXT,
  decision_id         TEXT,
  intent_hash         TEXT,
  quote_digest        TEXT,

  provider            TEXT,
  capability          TEXT,

  -- EVALUATED             — the engine decided. No authorization verified yet.
  -- PAYMENT_AUTH_VERIFIED — an authorization passed verification. Nothing has settled.
  -- SETTLEMENT_PENDING    — settlement was submitted and its outcome is not yet known.
  -- SETTLED               — a settlement is authoritatively confirmed for this call.
  -- SETTLEMENT_FAILED     — settlement conclusively failed. Terminal for the attempt, not the call.
  -- FINALIZATION_PENDING  — settled, and the finalizer has claimed it but not committed.
  -- FINALIZED             — settled AND the approval was activated. The only replayable state.
  -- CANCELLED             — abandoned before settlement.
  --
  -- SETTLED and FINALIZED are deliberately distinct. A settled fee whose approval never activated is
  -- exactly the cut point where the process died after settlement, and a model that cannot name that
  -- state cannot recover from it.
  state               TEXT        NOT NULL DEFAULT 'EVALUATED',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at          TIMESTAMPTZ,
  finalized_at        TIMESTAMPTZ,

  CONSTRAINT untch_x402_call_state_known CHECK (state IN (
    'EVALUATED', 'PAYMENT_AUTH_VERIFIED', 'SETTLEMENT_PENDING', 'SETTLED',
    'SETTLEMENT_FAILED', 'FINALIZATION_PENDING', 'FINALIZED', 'CANCELLED'
  )),
  -- A settled call must say when. "SETTLED, at some unknown time" cannot be compared against an
  -- authorization validity window, which is the one comparison reconciliation depends on.
  CONSTRAINT untch_x402_call_settled_dated
    CHECK (state NOT IN ('SETTLED', 'FINALIZATION_PENDING', 'FINALIZED') OR settled_at IS NOT NULL),
  CONSTRAINT untch_x402_call_finalized_dated
    CHECK (state <> 'FINALIZED' OR finalized_at IS NOT NULL)
);

-- The identity a retry resolves on. All four parts, because a client key alone is the client's
-- namespace and the fingerprint alone would merge two accounts asking for the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS untch_x402_call_idempotency
  ON untch_x402_service_calls (account_id, route, idempotency_key, request_fingerprint);

CREATE INDEX IF NOT EXISTS untch_x402_call_by_account ON untch_x402_service_calls (account_id, created_at DESC);
-- The reconciler's working set. Partial so it stays small however many calls succeed.
CREATE INDEX IF NOT EXISTS untch_x402_call_unfinished ON untch_x402_service_calls (state, updated_at)
  WHERE state IN ('SETTLEMENT_PENDING', 'SETTLED', 'FINALIZATION_PENDING');

-- ─────────────────────────────────────────────────────────────────────────────
-- The payment attempt: one EIP-3009 authorization
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A service call may have several attempts. It may have at most ONE settled attempt, ever, and the
-- partial unique index below is what makes that a property of the schema rather than of a check
-- somebody remembered to write.

CREATE TABLE IF NOT EXISTS untch_x402_payment_attempts (
  attempt_id          TEXT PRIMARY KEY,
  service_call_id     TEXT        NOT NULL REFERENCES untch_x402_service_calls(service_call_id) ON DELETE CASCADE,

  -- The settlement correlation key. Unique across the whole table: an EIP-3009 nonce is single-use by
  -- construction, and two rows claiming one would mean two attempts believing they own one transfer.
  authorization_nonce TEXT        NOT NULL,
  -- A hash over the exact authorized terms. The full signed authorization is NEVER stored: it is a
  -- bearer instrument, and a database that holds one is a database that can spend it.
  authorization_digest TEXT       NOT NULL,

  payer               TEXT        NOT NULL,
  token               TEXT        NOT NULL,
  amount              TEXT        NOT NULL,
  pay_to              TEXT        NOT NULL,
  chain               TEXT        NOT NULL,

  valid_after         TIMESTAMPTZ,
  valid_before        TIMESTAMPTZ,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- VERIFIED           — the authorization checked out. Nothing submitted.
  -- SETTLEMENT_PENDING — submitted, outcome unknown.
  -- SETTLED            — authoritatively confirmed. NOT merely `success: true` from the middleware.
  -- FAILED             — conclusively failed.
  -- SUPERSEDED         — a later attempt replaced it before it settled.
  -- ABANDONED          — its validity window closed with no settlement, so it can never settle now.
  -- UNKNOWN            — asked and could not be told. Non-actionable until reconciled, and NEVER
  --                      collapsed into FAILED, because "we do not know" and "it did not happen" have
  --                      opposite consequences for whether a second attempt may be charged.
  state               TEXT        NOT NULL DEFAULT 'VERIFIED',

  -- Filled in as evidence arrives, not at insert. Their absence on a SETTLED row is a contradiction,
  -- which is why the constraint below exists.
  payment_id          TEXT,
  transaction_hash    TEXT,
  facilitator_status  TEXT,
  settled_at          TIMESTAMPTZ,
  failure_code        TEXT,
  failure_detail      TEXT,

  reconciled_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_x402_attempt_state_known CHECK (state IN (
    'VERIFIED', 'SETTLEMENT_PENDING', 'SETTLED', 'FAILED', 'SUPERSEDED', 'ABANDONED', 'UNKNOWN'
  )),
  CONSTRAINT untch_x402_attempt_amount_decimal CHECK (amount ~ '^[0-9]{1,30}$'),
  -- A settled attempt without a transaction hash is an assertion with no evidence behind it. This is
  -- the constraint that stops a `pending` facilitator result from being written as SETTLED, because a
  -- pending result that carries no hash simply cannot be recorded in that state.
  CONSTRAINT untch_x402_attempt_settled_has_evidence
    CHECK (state <> 'SETTLED' OR (transaction_hash IS NOT NULL AND settled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS untch_x402_attempt_nonce ON untch_x402_payment_attempts (authorization_nonce);
-- AT MOST ONE settled attempt per service call. The property that makes double-charging a write
-- failure rather than a policy.
CREATE UNIQUE INDEX IF NOT EXISTS untch_x402_attempt_one_settled_per_call
  ON untch_x402_payment_attempts (service_call_id) WHERE state = 'SETTLED';
CREATE UNIQUE INDEX IF NOT EXISTS untch_x402_attempt_one_tx
  ON untch_x402_payment_attempts (transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS untch_x402_attempt_by_call ON untch_x402_payment_attempts (service_call_id, created_at);
CREATE INDEX IF NOT EXISTS untch_x402_attempt_unresolved ON untch_x402_payment_attempts (state, updated_at)
  WHERE state IN ('SETTLEMENT_PENDING', 'UNKNOWN');

-- ─────────────────────────────────────────────────────────────────────────────
-- The approval request grows a payment half and a V3 half
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Migration 017 already built the part that matters most: a digest that names the exact obligation, and
-- `approval_digest NOT NULL` on every decision row so a channel that received the word "yes" has
-- nothing to write. Migration 025 added the requester principal. What is missing is everything that
-- ties an approval to a PAYMENT, plus the V3 commitments the digest should now cover.

ALTER TABLE untch_approval_requests
  ADD COLUMN IF NOT EXISTS service_call_id               TEXT REFERENCES untch_x402_service_calls(service_call_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS settled_attempt_id            TEXT REFERENCES untch_x402_payment_attempts(attempt_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS decision_id                   TEXT,
  ADD COLUMN IF NOT EXISTS intent_hash                   TEXT,
  ADD COLUMN IF NOT EXISTS policy_hash                   TEXT,
  ADD COLUMN IF NOT EXISTS policy_snapshot_hash          TEXT,
  ADD COLUMN IF NOT EXISTS chain                         TEXT,
  ADD COLUMN IF NOT EXISTS task_hash                     TEXT,
  ADD COLUMN IF NOT EXISTS acceptance_hash               TEXT,
  ADD COLUMN IF NOT EXISTS requester_commitment          TEXT,
  ADD COLUMN IF NOT EXISTS metadata_commitment           TEXT,
  ADD COLUMN IF NOT EXISTS economic_classification       TEXT,
  ADD COLUMN IF NOT EXISTS approval_digest_schema_version INTEGER,
  -- 017's `expires_at` is when the APPROVAL window closes. A request can also age out on its own
  -- terms, because the quote it names has a life independent of how long a human is given.
  ADD COLUMN IF NOT EXISTS request_expires_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at                  TIMESTAMPTZ;

-- The lifecycle gains the two states the settlement boundary requires. REJECTED is kept rather than
-- renamed to DENIED: the semantics are identical, rows already carry it, and a rename would be
-- churn that buys nothing.
ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_state_known;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_state_known
  CHECK (state IN (
    'PROVISIONAL', 'PENDING', 'PAYMENT_FAILED',
    'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'EXECUTED', 'CANCELLED'
  ));

-- 017 required a resolved_at for anything not PENDING. PROVISIONAL and PAYMENT_FAILED are not
-- resolved, they are pre-actionable, so the rule is restated to name them.
ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_resolved_dated;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_resolved_dated
  CHECK (state IN ('PROVISIONAL', 'PENDING', 'PAYMENT_FAILED') OR resolved_at IS NOT NULL);

-- The load-bearing constraint of this file.
--
-- A request a human may act on must name the settled payment that bought it. PROVISIONAL and
-- PAYMENT_FAILED may not name one, because neither has a confirmed settlement. Every actionable and
-- post-actionable state MUST. This is what makes "an unsettled fee cannot create an actionable
-- request" impossible to violate, rather than merely intended.
ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_actionable_is_paid;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_actionable_is_paid
  CHECK (
    (state IN ('PROVISIONAL', 'PAYMENT_FAILED') AND settled_attempt_id IS NULL AND activated_at IS NULL)
    OR
    (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'EXECUTED', 'CANCELLED')
     AND settled_attempt_id IS NOT NULL AND activated_at IS NOT NULL)
  );

-- ONE approval request per service call. Two would mean one fee bought two promises.
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_per_service_call
  ON untch_approval_requests (service_call_id) WHERE service_call_id IS NOT NULL;

-- ONE settlement cannot activate two requests.
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_per_settled_attempt
  ON untch_approval_requests (settled_attempt_id) WHERE settled_attempt_id IS NOT NULL;

-- 017's one-open-per-intent index counted only PENDING. PROVISIONAL is also open, in the sense that a
-- second one for the same intent would race to become the PENDING one.
DROP INDEX IF EXISTS untch_approval_one_open_per_intent;
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_open_per_intent
  ON untch_approval_requests (intent_id) WHERE state IN ('PROVISIONAL', 'PENDING');

-- One live request per digest. A superseded or terminal one may share it; two ACTIONABLE ones may not.
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_current_per_digest
  ON untch_approval_requests (approval_digest) WHERE state IN ('PROVISIONAL', 'PENDING');

-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Enforced in the database because more than one writer will exist, and because "the amount changed
-- after a human agreed to it" is precisely the failure the digest exists to prevent. A trigger rather
-- than a constraint, since a constraint cannot see the previous row.

CREATE OR REPLACE FUNCTION untch_approval_request_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'untch_approval_requests.account_id is immutable (% -> %)', OLD.account_id, NEW.account_id;
  END IF;
  IF NEW.approval_digest IS DISTINCT FROM OLD.approval_digest THEN
    RAISE EXCEPTION 'untch_approval_requests.approval_digest is immutable';
  END IF;
  IF NEW.service_call_id IS DISTINCT FROM OLD.service_call_id AND OLD.service_call_id IS NOT NULL THEN
    RAISE EXCEPTION 'untch_approval_requests.service_call_id is immutable once set';
  END IF;
  IF NEW.settled_attempt_id IS DISTINCT FROM OLD.settled_attempt_id AND OLD.settled_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'untch_approval_requests.settled_attempt_id is immutable once set';
  END IF;
  IF OLD.requester_principal_ref IS NOT NULL
     AND NEW.requester_principal_ref IS DISTINCT FROM OLD.requester_principal_ref THEN
    RAISE EXCEPTION 'untch_approval_requests.requester_principal_ref is immutable once set';
  END IF;
  IF OLD.wallet_authority_ref IS NOT NULL
     AND NEW.wallet_authority_ref IS DISTINCT FROM OLD.wallet_authority_ref THEN
    RAISE EXCEPTION 'untch_approval_requests.wallet_authority_ref is immutable once set';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.recipient IS DISTINCT FROM OLD.recipient THEN
    RAISE EXCEPTION 'untch_approval_requests payment terms are immutable';
  END IF;
  -- The transitions money depends on. A payment that failed can never become one a human may act on,
  -- and an activated request can never fall back to pre-activation.
  IF OLD.state = 'PAYMENT_FAILED' AND NEW.state <> 'PAYMENT_FAILED' THEN
    RAISE EXCEPTION 'untch_approval_requests: PAYMENT_FAILED is terminal (attempted -> %)', NEW.state;
  END IF;
  IF OLD.state <> 'PROVISIONAL' AND NEW.state = 'PROVISIONAL' THEN
    RAISE EXCEPTION 'untch_approval_requests: cannot return to PROVISIONAL from %', OLD.state;
  END IF;
  IF OLD.state IN ('APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'EXECUTED', 'CANCELLED')
     AND NEW.state = 'PENDING' THEN
    RAISE EXCEPTION 'untch_approval_requests: % is terminal and cannot return to PENDING', OLD.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_approval_request_immutable_trg ON untch_approval_requests;
CREATE TRIGGER untch_approval_request_immutable_trg
  BEFORE UPDATE ON untch_approval_requests
  FOR EACH ROW EXECUTE FUNCTION untch_approval_request_immutable();

CREATE OR REPLACE FUNCTION untch_x402_attempt_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.service_call_id IS DISTINCT FROM OLD.service_call_id THEN
    RAISE EXCEPTION 'untch_x402_payment_attempts.service_call_id is immutable';
  END IF;
  IF NEW.authorization_nonce IS DISTINCT FROM OLD.authorization_nonce THEN
    RAISE EXCEPTION 'untch_x402_payment_attempts.authorization_nonce is immutable';
  END IF;
  IF NEW.payer IS DISTINCT FROM OLD.payer OR NEW.token IS DISTINCT FROM OLD.token
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.pay_to IS DISTINCT FROM OLD.pay_to
     OR NEW.chain IS DISTINCT FROM OLD.chain THEN
    RAISE EXCEPTION 'untch_x402_payment_attempts payment terms are immutable';
  END IF;
  -- Settled is where evidence lands. Moving off it would orphan a real transfer.
  IF OLD.state = 'SETTLED' AND NEW.state <> 'SETTLED' THEN
    RAISE EXCEPTION 'untch_x402_payment_attempts: SETTLED is terminal (attempted -> %)', NEW.state;
  END IF;
  IF OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
    RAISE EXCEPTION 'untch_x402_payment_attempts.transaction_hash is immutable once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_x402_attempt_immutable_trg ON untch_x402_payment_attempts;
CREATE TRIGGER untch_x402_attempt_immutable_trg
  BEFORE UPDATE ON untch_x402_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION untch_x402_attempt_immutable();

-- A settled service call may never accept another payable attempt. Enforced on INSERT, because by the
-- time a uniqueness violation fired on the settled index the second transfer would already have
-- happened on chain and no constraint could undo it.
CREATE OR REPLACE FUNCTION untch_x402_attempt_call_not_settled() RETURNS TRIGGER AS $$
DECLARE
  call_state TEXT;
BEGIN
  SELECT state INTO call_state FROM untch_x402_service_calls WHERE service_call_id = NEW.service_call_id;
  IF call_state IN ('SETTLED', 'FINALIZATION_PENDING', 'FINALIZED') THEN
    RAISE EXCEPTION 'service call % is already % and cannot accept another payment attempt',
      NEW.service_call_id, call_state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_x402_attempt_call_not_settled_trg ON untch_x402_payment_attempts;
CREATE TRIGGER untch_x402_attempt_call_not_settled_trg
  BEFORE INSERT ON untch_x402_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION untch_x402_attempt_call_not_settled();

-- ─────────────────────────────────────────────────────────────────────────────
-- The approval outbox
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Its own table rather than `consumer_outbox`, which is FK-bound to `consumer_intents` and carries a
-- per-intent gapless sequence. An ApprovalRequest has no consumer intent, and forcing one would invent
-- a row to satisfy a foreign key.
--
-- Nothing sends these in this phase. The event existing and the event being delivered are separate
-- claims, and only the first is true here.

CREATE TABLE IF NOT EXISTS untch_approval_outbox (
  event_id            TEXT PRIMARY KEY,
  approval_request_id TEXT        NOT NULL REFERENCES untch_approval_requests(approval_request_id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  -- Allow-listed projection only. No raw account id, no wallet binding id, no bearer token, no
  -- channel subject. The writer builds this, and the tests assert what is absent from it.
  data                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  dispatched          BOOLEAN     NOT NULL DEFAULT FALSE,
  attempts            INTEGER     NOT NULL DEFAULT 0,
  last_error          TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_approval_outbox_name_known CHECK (name IN ('approval.request.ready.v1'))
);

-- ONE ready event per request. Repeated finalization cannot produce a second notification.
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_outbox_one_ready
  ON untch_approval_outbox (approval_request_id, name);
CREATE INDEX IF NOT EXISTS untch_approval_outbox_pending ON untch_approval_outbox (occurred_at)
  WHERE dispatched = FALSE;

COMMENT ON TABLE untch_x402_service_calls IS
  'One requested Untch service, stable across retries. NOT untch_decision_service_calls, which is a per-service cooldown clock. FINALIZED is the only state a replay may be answered from.';

COMMENT ON TABLE untch_x402_payment_attempts IS
  'One EIP-3009 authorization. SETTLED requires a transaction hash, which is what stops a pending facilitator result — reported by processSettlement as success:true — from being recorded as confirmed.';

COMMENT ON COLUMN untch_approval_requests.settled_attempt_id IS
  'The settled payment that bought this request. NULL is only legal while PROVISIONAL or PAYMENT_FAILED. Every actionable state requires it, which is how an unsettled fee is prevented from creating a promise to a human.';
