-- Authority reserved is not money spent.
--
-- WHAT WAS WRONG
--
-- An APPROVED preflight added the governed amount to a daily counter named `spentTodayByAgent`, and
-- every surface downstream read that noun literally:
--
--   • the engine's budget.daily rule projected "spentToday + amount";
--   • the receipt writer wrote an APPROVED DECISION as a ledger row of type SPEND, with the governed
--     amount, which is how a 4.00 authorisation became a 4,000,000-base-unit SPEND row on
--     2026-08-02 for a decision where nothing was paid;
--   • the reconcile report described those rows as "money that actually moved";
--   • the dashboard rendered them under a tile reading "Spent", against a budget meter, with the
--     caption "Spend counts only approved payments".
--
-- `/preflight_payment` is decision-only. It judges a proposed spend and executes nothing. So the 4.00
-- was authority granted, and calling it spend made an authorisation look like a completed payment at
-- four layers of the product.
--
-- WHY A COUNTER COULD NOT SIMPLY BE RENAMED
--
-- Because the lifecycle was missing, not just the noun. Authority that is granted must later be
-- CONSUMED when execution settles, or RELEASED when it expires, fails, is superseded or is cancelled.
-- A number that only goes up can express neither. And dropping the counter entirely is not an option
-- either: without it, two agents could each be approved against the same remaining budget, because
-- neither approval would be visible to the other until money moved.
--
-- So: a durable reservation with a status, and a budget rule that enforces against
-- settled + still-active-reserved while REPORTING them separately.
--
-- WHAT THIS TABLE IS NOT
--
-- It is not the accounting ledger. An authorisation hold is not a double-entry transaction, and
-- overloading `ledger_entries` to carry holds is exactly how the two got confused in the first place.
-- Settlement, when it happens, writes the ledger; this table records what was permitted.

CREATE TABLE IF NOT EXISTS untch_budget_reservations (
  reservation_id          TEXT PRIMARY KEY,

  -- PRIVATE. The account whose budget this consumes.
  account_id              TEXT        NOT NULL,
  policy_id               TEXT        NOT NULL,
  -- `policy:<policyId>` — the same partition the duplicate window and rate counters use.
  partition_key           TEXT        NOT NULL,

  decision_id             TEXT        NOT NULL,
  intent_id               TEXT        NOT NULL,
  intent_hash             TEXT        NOT NULL,
  quote_digest            TEXT        NOT NULL,

  -- Who was authorised. A reservation is bound to a requester, so account A's hold can never be
  -- consumed by account B even if every other field matched.
  requester_principal_ref TEXT        NOT NULL,
  wallet_authority_ref    TEXT        NOT NULL,

  -- NUMERIC, never float: a hold that drifted by fractions would make a budget ceiling wrong in a
  -- direction nobody chose.
  amount                  NUMERIC(38,18) NOT NULL,
  asset                   TEXT        NOT NULL,
  chain                   TEXT        NOT NULL,
  recipient               TEXT,
  provider                TEXT        NOT NULL,
  capability              TEXT        NOT NULL,

  -- The UTC day the hold counts against, so the daily window can be summed without date arithmetic
  -- disagreeing with the engine's own day key.
  day_key                 TEXT        NOT NULL,

  status                  TEXT        NOT NULL DEFAULT 'ACTIVE',

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- After this instant the hold stops counting toward exposure even if nothing swept it. A hold that
  -- outlived its authorisation would quietly shrink a user's budget forever.
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ,
  released_at             TIMESTAMPTZ,
  release_reason          TEXT,

  -- What consumed it. Null while ACTIVE; set in the same transaction that marks it CONSUMED.
  execution_ref           TEXT,
  settlement_ref          TEXT,

  CONSTRAINT untch_reservation_status_known
    CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED', 'SUPERSEDED')),

  -- A terminal status must carry its timestamp, or "when did this stop counting" has no answer.
  CONSTRAINT untch_reservation_consumed_is_stamped
    CHECK (status <> 'CONSUMED' OR (consumed_at IS NOT NULL AND execution_ref IS NOT NULL)),
  CONSTRAINT untch_reservation_released_is_stamped
    CHECK (status NOT IN ('RELEASED', 'EXPIRED', 'SUPERSEDED')
           OR (released_at IS NOT NULL AND release_reason IS NOT NULL)),
  CONSTRAINT untch_reservation_amount_positive CHECK (amount > 0)
);

/*
 * ONE ACTIVE RESERVATION PER INTENT HASH.
 *
 * The property that makes execution idempotent: a retry cannot create a second hold for work that was
 * authorised once, and two concurrent approvals of the same intent cannot both reserve. A partial
 * unique index rather than a plain one, because the same intent legitimately has a history of
 * released and superseded holds — it is only the ACTIVE one that must be unique.
 */
CREATE UNIQUE INDEX IF NOT EXISTS untch_reservation_one_active_per_intent
  ON untch_budget_reservations (partition_key, intent_hash)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS untch_reservation_exposure
  ON untch_budget_reservations (partition_key, day_key, status);

CREATE INDEX IF NOT EXISTS untch_reservation_account
  ON untch_budget_reservations (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS untch_reservation_decision
  ON untch_budget_reservations (decision_id);

/*
 * History is never deleted, and a terminal reservation never goes back to ACTIVE.
 *
 * A released hold that could be reactivated would let capacity be reclaimed after the budget had
 * already been re-lent to something else. A deleted one would erase the evidence that authority was
 * ever granted — which is precisely what a dispute needs to read.
 */
CREATE OR REPLACE FUNCTION untch_reservation_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'untch_budget_reservations rows are permanent: reservation % for account % records '
      'that authority was granted, and a dispute reads that history. Release it instead.',
      OLD.reservation_id, OLD.account_id;
  END IF;

  IF OLD.status <> 'ACTIVE' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'reservation % is already %, and cannot become %. A terminal hold that could be '
      'reactivated would reclaim budget capacity that has since been lent to something else.',
      OLD.reservation_id, OLD.status, NEW.status;
  END IF;

  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.intent_hash IS DISTINCT FROM OLD.intent_hash
     OR NEW.quote_digest IS DISTINCT FROM OLD.quote_digest
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.requester_principal_ref IS DISTINCT FROM OLD.requester_principal_ref
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id THEN
    RAISE EXCEPTION 'the identity and amount of reservation % are fixed at creation: a hold that could '
      'be re-pointed would let a 6.00 authorisation fund a 6.50 execution.', OLD.reservation_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_reservation_append_only ON untch_budget_reservations;
CREATE TRIGGER untch_reservation_append_only
  BEFORE UPDATE OR DELETE ON untch_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION untch_reservation_is_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- Settled spend, which is a different table because it is a different fact
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Money that actually moved for a governed spend. Written when a reservation is CONSUMED, never by a
-- decision. It is currently always empty, and that is the correct state: `/preflight_payment` is
-- decision-only and no execution path has settled a governed amount through this model yet. An empty
-- table is an honest answer; the old counter's non-zero value was not.

CREATE TABLE IF NOT EXISTS untch_settled_spend (
  partition_key TEXT           NOT NULL,
  day_key       TEXT           NOT NULL,
  amount        NUMERIC(38,18) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (partition_key, day_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The old counter, retired rather than renamed
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `untch_decision_daily_spend` was introduced in 026 and holds the same conflation this migration
-- exists to remove. It has never held a committed production row — `untch_decision_evidence` is empty
-- in production — so there is nothing to migrate and nothing to reinterpret. Dropping it is cleaner
-- than leaving a table whose name asserts something untrue.
--
-- Deliberately NOT reinterpreted as reservations: the quarantined 2026-08-02 validation artifacts are
-- not authority anybody was granted, and converting them would manufacture holds against a real
-- user's budget from a leak.

DROP TABLE IF EXISTS untch_decision_daily_spend;

COMMENT ON TABLE untch_budget_reservations IS
  'Authority granted and not yet settled. NOT money spent, and NOT an accounting ledger entry. Counts toward effective budget usage while ACTIVE so concurrent agents cannot over-authorize one account; stops counting when CONSUMED, RELEASED, EXPIRED or SUPERSEDED. History is permanent.';

COMMENT ON TABLE untch_settled_spend IS
  'Money that actually moved for a governed spend, written only when a reservation is CONSUMED. Empty is the correct state while /preflight_payment remains decision_only.';
