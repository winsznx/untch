-- The state a decision reads, moved out of process memory and into the transaction.
--
-- WHAT WENT WRONG, EXACTLY
--
-- The policy engine read its window state from `InMemoryLedger` — a process singleton — and committed
-- an APPROVED intent's spend, duplicate marker, rate tick and cooldown clock straight back into it,
-- outside any caller transaction.
--
-- The always-rollback validation route exists to change nothing. It rolled back its database writes
-- perfectly and could not roll back that commit, because the commit never went to the database. So on
-- 2026-08-03 a non-billable validation at 4.00 registered a real duplicate marker, and a genuine 4.00
-- request minutes later returned BLOCKED_DUPLICATE. Had that been the paid call it would have cost
-- 0.05 USDT0 to be told "duplicate" by the system's own rehearsal of itself.
--
-- It is the same defect as the escalation leak, one layer down. That one was "a rolled-back validation
-- must not message a human". This is "a rolled-back validation must not change a later decision".
--
-- WHY A PROCESS SINGLETON WAS ALWAYS GOING TO BREAK
--
--   • it cannot be rolled back, so validation and production share one mutable world;
--   • it dies on restart, so the duplicate window a policy commits to on chain silently empties;
--   • it is per-process, so two ASP replicas enforce two different budgets, two different rate
--     limits, and neither sees the other's duplicates.
--
-- All three are the same missing property: the state a decision reads must live where a decision's
-- transaction lives.
--
-- THE LOCK IS TRANSACTION-SCOPED ON PURPOSE
--
-- `pg_advisory_xact_lock` is taken on the partition key inside the caller's transaction and released
-- by COMMIT or ROLLBACK — the database does it, not a `finally` block. That gives cross-instance
-- serialisation of the read→evaluate→commit critical section, which the in-process mutex could never
-- do, and it cannot leak a held lock when a request dies mid-flight.

-- ─────────────────────────────────────────────────────────────────────────────
-- Recent intents — the duplicate window
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every column a `duplicates.keys` tuple may name is stored. A row missing a named field is one the
-- rule cannot compare, and the rule treats that as "not a duplicate" — failing open on the exact
-- thing it exists to catch. Storing the whole tuple is what keeps that from happening silently.

CREATE TABLE IF NOT EXISTS untch_decision_recent_intents (
  id              BIGSERIAL PRIMARY KEY,
  -- `policy:<policyId>`. Never the raw buyerAgentId: that value is routinely the ubiquitous "1"
  -- across unrelated agents, and two owners sharing it would share one duplicate window.
  partition_key   TEXT        NOT NULL,
  intent_id       TEXT        NOT NULL,
  intent_hash     TEXT        NOT NULL,
  task_hash       TEXT        NOT NULL,
  endpoint        TEXT        NOT NULL,
  params_hash     TEXT        NOT NULL,
  max_amount      TEXT,
  recipient_address TEXT,
  category        TEXT,
  created_at_ms   BIGINT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS untch_decision_recent_intents_window
  ON untch_decision_recent_intents (partition_key, created_at_ms DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Daily budget consumption
-- ─────────────────────────────────────────────────────────────────────────────
--
-- NUMERIC, not double precision. The engine works in display units and a float would make a budget
-- ceiling drift by fractions of a cent per call in a direction nobody chose.

CREATE TABLE IF NOT EXISTS untch_decision_daily_spend (
  partition_key TEXT           NOT NULL,
  day_key       TEXT           NOT NULL,
  amount        NUMERIC(38,18) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (partition_key, day_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Rolling-hour rate ticks
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_decision_rate_ticks (
  id            BIGSERIAL PRIMARY KEY,
  partition_key TEXT   NOT NULL,
  called_at_ms  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS untch_decision_rate_ticks_window
  ON untch_decision_rate_ticks (partition_key, called_at_ms DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-service cooldown clocks
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_decision_service_calls (
  partition_key  TEXT   NOT NULL,
  service_host   TEXT   NOT NULL,
  last_called_ms BIGINT NOT NULL,
  PRIMARY KEY (partition_key, service_host)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Replay markers
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The PRIMARY KEY is what makes "two concurrent identical requests cannot both commit" a property of
-- the schema rather than of the lock. Even if the advisory lock were removed tomorrow, the second
-- committer would collide here instead of both succeeding.

CREATE TABLE IF NOT EXISTS untch_decision_replay_markers (
  partition_key TEXT        NOT NULL,
  intent_hash   TEXT        NOT NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (partition_key, intent_hash)
);

COMMENT ON TABLE untch_decision_recent_intents IS
  'The duplicate window a decision is measured against. Durable because a process singleton cannot be rolled back, dies on restart, and is invisible to a second replica — and a decision must read state that lives where its transaction lives.';

COMMENT ON TABLE untch_decision_replay_markers IS
  'One committed decision per (partition, intentHash). The PRIMARY KEY is what stops two concurrent identical requests from both committing, independently of any lock.';
