-- ═════════════════════════════════════════════════════════════════════════════
-- A requote is a successor, and it may not retire its predecessor before it is paid for
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT 029 GOT RIGHT
--
-- Quote lineage exists. `supersedePriorQuote` retires the prior request, its reservation and its
-- deliveries in one transaction, and refuses a lineage mismatch, an unchanged quote and a cross-account
-- aim. None of that changes.
--
-- WHAT 029 COULD NOT EXPRESS
--
-- WHEN the supersession is allowed to happen. 029 was written before the paid approval model, when a
-- request became actionable the moment it was inserted. Under 028 and 030 a request is raised
-- PROVISIONAL, is bought by a service call, and becomes PENDING only when an authority confirms the fee
-- settled. So a requote has a window — between the handler committing and the settlement confirming —
-- in which the successor exists and has been paid for by nobody.
--
-- If the predecessor were retired at handler time, then a requote whose fee never settles would have
-- destroyed authority the user already approved, in exchange for nothing. The user would be left with a
-- 6.00 they had said yes to, revoked, and a 6.50 that cannot be activated. That is the failure this
-- file exists to make unrepresentable.
--
--     A FAILED PAYMENT MUST NOT REVOKE AUTHORITY A PERSON ALREADY GRANTED.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The index that would have blocked the successor from existing at all
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 029's `untch_approval_one_open_per_lineage` is UNIQUE on the lineage across PROVISIONAL and PENDING
-- together. That was correct when those two states meant the same thing. They no longer do:
--
--   PENDING     — actionable. A human can answer it. It holds authority the moment they do.
--   PROVISIONAL — not actionable by construction. No outbox event, no delivery, no action reference,
--                 no reservation, and the 030 backstop refuses a decision on it because its service
--                 call is not FINALIZED.
--
-- Counting them together means a PROVISIONAL successor cannot be inserted while its PENDING predecessor
-- is still live — which is exactly the state a correct requote has to pass through. So the one index
-- becomes two, and each states the invariant that is actually true of its own state:
--
--   at most one ANSWERABLE request per lineage    (PENDING)
--   at most one IN-FLIGHT successor per lineage   (PROVISIONAL)
--
-- The second is what makes "one active successor per lineage" enforceable rather than checked: two
-- concurrent requotes on one lineage race to insert, and the loser gets a unique violation rather than
-- a second live successor.

DROP INDEX IF EXISTS untch_approval_one_open_per_lineage;

CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_pending_per_lineage
  ON untch_approval_requests (quote_lineage_id)
  WHERE quote_lineage_id IS NOT NULL AND state = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_provisional_per_lineage
  ON untch_approval_requests (quote_lineage_id)
  WHERE quote_lineage_id IS NOT NULL AND state = 'PROVISIONAL';

-- ─────────────────────────────────────────────────────────────────────────────
-- Which version of the quote this is
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The V3 quote terms already carry `lineage` and `version`, and the digest hashes both. The version was
-- being written as a constant 1 because nothing tracked it. Stored here so a requote's digest commits
-- the position in the lineage rather than a number the handler guessed, and so two requotes of one
-- lineage can never produce the same digest even if every commercial term matched.

ALTER TABLE untch_approval_requests
  ADD COLUMN IF NOT EXISTS quote_version INTEGER NOT NULL DEFAULT 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- The commercial identity a requote has to match, written where it can be compared
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A requote may change the PRICE and nothing else. Provider, capability, asset, chain, recipient,
-- policy and requester are already columns on this table and were already comparable. The task and the
-- acceptance criteria were not: they existed only inside the approval digest's v3 binding, which is a
-- hash and therefore answers "did all of this match" and never "which field moved".
--
-- Stored here so a requote that quietly changes the work can be refused BY NAME. Without them the only
-- available check is the whole digest, and the whole digest differs on every requote by design — so the
-- substitution would pass unexamined.

ALTER TABLE untch_approval_requests
  ADD COLUMN IF NOT EXISTS task_hash       TEXT,
  ADD COLUMN IF NOT EXISTS acceptance_hash TEXT;

ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_quote_version_positive;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_quote_version_positive
  CHECK (quote_version >= 1);

-- BACKFILL BEFORE CONSTRAINING.
--
-- 029 already allowed a request to name `supersedes_approval_request_id`, and any row that did is a
-- successor that was valid when it was written. `quote_version` defaults to 1, and the constraint below
-- says a version-1 row names no predecessor — so without this, adding that constraint would fail the
-- migration on data that is not wrong, only older than the column describing it.
--
-- This grants nothing and changes no meaning. It writes down, in the new vocabulary, exactly what the
-- old columns already said: a row that names a predecessor is a successor, and a successor is at least
-- version 2.
UPDATE untch_approval_requests
   SET quote_version = 2
 WHERE supersedes_approval_request_id IS NOT NULL AND quote_version = 1;

-- Same reasoning for the lineage. A successor written before lineage was mandatory can borrow the one
-- its predecessor carries, which is the lineage it was always in — and if the predecessor has none
-- either, both get one, because a pair related by supersession IS a lineage whether or not anything
-- had named it.
UPDATE untch_approval_requests successor
   SET quote_lineage_id = COALESCE(
         predecessor.quote_lineage_id,
         'qln_backfill_' || substr(md5(successor.supersedes_approval_request_id), 1, 24))
  FROM untch_approval_requests predecessor
 WHERE successor.supersedes_approval_request_id = predecessor.approval_request_id
   AND successor.quote_lineage_id IS NULL;

-- And the other end of the same pair. A predecessor left with a NULL lineage beside a successor that
-- now has one is a pair the supersession backstop below would refuse to complete, because that check
-- compares the two lineages and a NULL is distinct from everything. Both halves, or neither.
UPDATE untch_approval_requests predecessor
   SET quote_lineage_id = successor.quote_lineage_id
  FROM untch_approval_requests successor
 WHERE successor.supersedes_approval_request_id = predecessor.approval_request_id
   AND predecessor.quote_lineage_id IS NULL
   AND successor.quote_lineage_id IS NOT NULL;

-- A first quote is version 1 and names no predecessor. A successor is version 2 or more and names one.
-- Stated as a constraint because the two halves are the same fact, and a row where they disagree is a
-- row whose digest committed to a lineage position it does not occupy.
ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_successor_names_predecessor;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_successor_names_predecessor
  CHECK (
    (quote_version = 1 AND supersedes_approval_request_id IS NULL)
    OR (quote_version > 1 AND supersedes_approval_request_id IS NOT NULL)
  );

-- Nothing supersedes itself. A cycle of one is still a cycle, and it would make the timeline walk in
-- `approval-case-projection` non-terminating.
ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_no_self_supersession;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_no_self_supersession
  CHECK (supersedes_approval_request_id IS DISTINCT FROM approval_request_id);

-- A successor names a predecessor, and a predecessor carries a lineage. So a successor must carry one
-- too, or the lineage it claims membership of cannot be read from the row.
ALTER TABLE untch_approval_requests DROP CONSTRAINT IF EXISTS untch_approval_successor_has_lineage;
ALTER TABLE untch_approval_requests ADD CONSTRAINT untch_approval_successor_has_lineage
  CHECK (supersedes_approval_request_id IS NULL OR quote_lineage_id IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- The backstop: a predecessor may only be retired by a successor that was paid for
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS IS IN THE DATABASE AND NOT ONLY IN `finalizeSettlement`
--
-- Because the same reasoning 030 records applies here with more money attached. The supersession is
-- correct in the finalizer today. It stops being correct the first time somebody writes a repair
-- script, adds a sweeper, or opens psql to "clean up a stuck lineage" — and the damage is silent:
-- authority a person granted disappears and nothing in the record says it should not have.
--
-- THE RULE
--
-- A request may move to SUPERSEDED only if the successor that names it has a FINALIZED service call.
-- FINALIZED is the state `finalizeSettlement` writes and only after `getSettleStatus` confirmed a named
-- transaction, so this is the settlement condition restated where a forgotten code path cannot get
-- around it.
--
-- WHAT IS EXEMPT, AND WHY
--
-- A predecessor with no successor. `supersedePriorQuote` is also reachable from the pre-paid model,
-- where a supersession is recorded with `superseded_by_approval_request_id` set in the same transaction
-- — so the check reads the successor when there is one and permits the legacy shape when there is not.
-- Demanding a paid successor of a row that never had one would fail history for what it could not have.

CREATE OR REPLACE FUNCTION untch_supersession_must_be_paid_for() RETURNS TRIGGER AS $$
DECLARE
  successor   RECORD;
  call_state  TEXT;
BEGIN
  IF NEW.state <> 'SUPERSEDED' OR OLD.state = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;

  IF NEW.superseded_by_approval_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO successor
    FROM untch_approval_requests
   WHERE approval_request_id = NEW.superseded_by_approval_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'untch_approval_requests: % cannot be superseded by %, which does not exist',
      NEW.approval_request_id, NEW.superseded_by_approval_request_id;
  END IF;

  -- The successor has to actually claim this row. Without it, a successor could be pointed at any
  -- request in the table and retire authority it never replaced.
  IF successor.supersedes_approval_request_id IS DISTINCT FROM NEW.approval_request_id THEN
    RAISE EXCEPTION
      'untch_approval_requests: successor % does not name % as the request it supersedes',
      successor.approval_request_id, NEW.approval_request_id;
  END IF;

  IF successor.quote_lineage_id IS DISTINCT FROM NEW.quote_lineage_id THEN
    RAISE EXCEPTION
      'untch_approval_requests: successor % is in lineage %, and % is in lineage %',
      successor.approval_request_id, coalesce(successor.quote_lineage_id, 'none'),
      NEW.approval_request_id, coalesce(NEW.quote_lineage_id, 'none');
  END IF;

  IF successor.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION
      'untch_approval_requests: successor % belongs to a different account', successor.approval_request_id;
  END IF;

  -- A legacy successor has no service call, and 030 exempts exactly that shape for the same reason.
  IF successor.service_call_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT state INTO call_state
    FROM untch_x402_service_calls WHERE service_call_id = successor.service_call_id;

  -- BOTH SETTLED STATES COUNT, AND THE DISTINCTION IS WORTH BEING EXACT ABOUT.
  --
  -- `finalizeSettlement` writes FINALIZATION_PENDING only inside the CONFIRMED branch, after the
  -- evidence has been proven authoritative and every authorized term compared. It then writes FINALIZED
  -- at the end of the same transaction. So both states mean "an authority confirmed a named transaction
  -- for these exact terms", and the intermediate one is never observable outside that transaction.
  --
  -- The states this refuses are the ones that matter: EVALUATED, PAYMENT_AUTH_VERIFIED,
  -- SETTLEMENT_PENDING, SETTLEMENT_FAILED and CANCELLED. Every one of them is a successor whose fee has
  -- not been confirmed, and a supersession from any of them is authority destroyed for nothing.
  IF call_state IS DISTINCT FROM 'FINALIZED' AND call_state IS DISTINCT FROM 'FINALIZATION_PENDING' THEN
    RAISE EXCEPTION
      'untch_approval_requests: % may not be superseded — the successor''s service call % is %, and no '
      'authority has confirmed its payment. A failed or unconfirmed payment must not revoke authority '
      'that was already granted.',
      NEW.approval_request_id, successor.service_call_id, coalesce(call_state, 'missing');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_supersession_paid_backstop ON untch_approval_requests;
CREATE TRIGGER untch_supersession_paid_backstop
  BEFORE UPDATE ON untch_approval_requests
  FOR EACH ROW EXECUTE FUNCTION untch_supersession_must_be_paid_for();

-- ─────────────────────────────────────────────────────────────────────────────
-- A superseded reservation stops being authority
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The reservation's own status already carries SUPERSEDED and the exposure query already excludes it.
-- What was missing is the statement that the two move TOGETHER: a request retired with its reservation
-- still ACTIVE would hold 6.00 of a user's daily budget against work nobody is doing, and the exposure
-- would be right about the row and wrong about the world.

CREATE OR REPLACE FUNCTION untch_superseded_request_holds_no_authority() RETURNS TRIGGER AS $$
DECLARE
  live INTEGER;
BEGIN
  IF NEW.state <> 'SUPERSEDED' OR OLD.state = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO live
    FROM untch_budget_reservations
   WHERE approval_request_id = NEW.approval_request_id AND status = 'ACTIVE';

  IF live > 0 THEN
    RAISE EXCEPTION
      'untch_approval_requests: % is being superseded while % of its reservations are still ACTIVE',
      NEW.approval_request_id, live;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER, and a CONSTRAINT TRIGGER, for the reason 030 records: `supersedePriorQuote` updates the
-- request and then the reservation, and a BEFORE row trigger would refuse a correct writer for a
-- reservation it has not released yet. Evaluated at COMMIT, the whole unit is visible.
DROP TRIGGER IF EXISTS untch_superseded_holds_no_authority ON untch_approval_requests;
CREATE CONSTRAINT TRIGGER untch_superseded_holds_no_authority
  AFTER UPDATE ON untch_approval_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION untch_superseded_request_holds_no_authority();

COMMENT ON COLUMN untch_approval_requests.quote_version IS
  'Position in the quote lineage. 1 for a first quote, incremented by each requote. Hashed into the V3 quote digest, so two requotes of one lineage cannot collide even with identical commercial terms.';

COMMENT ON INDEX untch_approval_one_provisional_per_lineage IS
  'One in-flight successor per lineage. Two concurrent requotes race to insert here and the loser gets a unique violation rather than a second live successor.';
