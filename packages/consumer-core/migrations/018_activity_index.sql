-- A case-first evidence index, not a block explorer.
--
-- WHAT A BLOCK EXPLORER WOULD GET WRONG HERE
--
-- An explorer is organised by the chain: blocks, then transactions, then logs. That is the right shape
-- when the chain is the subject. It is the wrong shape for this system, because the thing a person
-- needs to see is ONE DECISION and everything that happened because of it — a marketplace payment on
-- one rail, a policy decision that never touched a chain at all, an escalation answered in a browser,
-- a provider settlement on a second rail, a delivery verification, a receipt anchor on a third. Those
-- live in five places and three chains, and a per-chain view shows five unrelated rows.
--
-- So the unit is an ActivityCase: one thing that happened, with every piece of evidence for it
-- underneath, whatever produced it. Chain events are one KIND of evidence, not the organising axis.
--
-- THE THREE STATES THAT MATTER MOST ARE THE UNCOMFORTABLE ONES
--
--   • UNRECONCILED   — a transaction touching a watched address that no case claims. Something moved
--                      money and this system cannot say why. That is the single most important row in
--                      the schema, and it exists so the answer is a query rather than a suspicion.
--   • SHADOW_EXECUTION — a transaction that looks like an execution and reconciles to no intent. Worse
--                      than unreconciled: not just unexplained, but shaped like something this system
--                      is supposed to be the only source of.
--   • ORPHANED       — an event that was read and then reorged away. Kept, marked, never deleted,
--                      because a receipt built on it needs to be able to say what happened.
--
-- MAINNET AND TESTNET NEVER SHARE A NAMESPACE
--
-- Every table here is keyed by `network` (a CAIP-2 id) alongside whatever else identifies the row. Not
-- as a filter callers are expected to remember — as part of the KEY. A testnet transaction hash and a
-- mainnet one can collide in principle and, far more importantly, a query that forgot to filter would
-- silently mix a rehearsal into a financial total. Making it part of the primary key means such a
-- query cannot be written by accident.

-- ─────────────────────────────────────────────────────────────────────────────
-- What is watched, and how far it has been read
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chain_sources (
  source_id     TEXT PRIMARY KEY,
  -- CAIP-2: eip155:196, eip155:8453, solana:5eykt4Us…. Never a friendly name — a friendly name is a
  -- thing two deployments can disagree about.
  network       TEXT        NOT NULL,
  -- 'contract' | 'treasury' | 'provider-settlement' | 'writer'.
  kind          TEXT        NOT NULL,
  address       TEXT        NOT NULL,
  label         TEXT        NOT NULL,
  -- FALSE is a live control, not a config comment: a source can be stopped without deleting the
  -- cursor, so restarting it resumes rather than re-reading from genesis.
  enabled       BOOLEAN     NOT NULL DEFAULT true,
  -- Where reading starts the first time. Later reads use the cursor.
  start_block   BIGINT      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chain_sources_kind_known
    CHECK (kind IN ('contract', 'treasury', 'provider-settlement', 'writer')),
  -- One address is watched once per network. Two rows for the same address would double every total
  -- computed from its transfers.
  CONSTRAINT chain_sources_unique_address UNIQUE (network, address)
);

CREATE TABLE IF NOT EXISTS chain_cursors (
  source_id        TEXT PRIMARY KEY REFERENCES chain_sources(source_id) ON DELETE CASCADE,
  network          TEXT        NOT NULL,

  -- The highest block whose logs have been READ. Distinct from `finalized_block` below, and the
  -- distinction is the whole reorg story: everything between the two is provisional.
  last_read_block  BIGINT      NOT NULL DEFAULT 0,
  -- The highest block considered final. Nothing at or below it is expected to change; anything above
  -- it may be re-read and may disagree with what was stored.
  finalized_block  BIGINT      NOT NULL DEFAULT 0,
  -- The hash of `last_read_block`. On the next pass, a different hash for the same height means a
  -- REORG — and this column is the only way to notice one without re-reading history every time.
  last_read_hash   TEXT,

  last_read_at     TIMESTAMPTZ,
  -- Consecutive failures. Reset on success. A source that keeps failing must be visible as a source
  -- that keeps failing, not as a source that is quietly behind.
  consecutive_errors INTEGER   NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chain_cursors_finalized_not_ahead CHECK (finalized_block <= last_read_block)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Raw evidence, kept exactly as read
-- ─────────────────────────────────────────────────────────────────────────────

-- The unmodified log, before any decoder touched it.
--
-- Kept SEPARATELY from the decoded form because decoders have versions and versions have bugs. When a
-- decoder is wrong, the fix must be re-running it — and that is only possible if the input survived.
-- A schema that stored only the decoded result would make every decoder bug permanent.
CREATE TABLE IF NOT EXISTS raw_chain_events (
  network        TEXT        NOT NULL,
  tx_hash        TEXT        NOT NULL,
  log_index      INTEGER     NOT NULL,

  block_number   BIGINT      NOT NULL,
  block_hash     TEXT        NOT NULL,
  block_time     TIMESTAMPTZ,
  address        TEXT        NOT NULL,
  topics         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  data           TEXT,

  -- 'LIVE' | 'ORPHANED'. An orphaned event was read and then reorged away. It is MARKED, never
  -- deleted: a receipt built on it has to be able to say what happened, and "the row is gone" is not
  -- an explanation anyone can act on.
  status         TEXT        NOT NULL DEFAULT 'LIVE',
  orphaned_at    TIMESTAMPTZ,

  -- Which decoder version produced the interpretation, and what it produced. NULL means nothing has
  -- decoded it yet, which is a normal state and not a failure.
  decoder_version TEXT,
  decoded        JSONB,

  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- `network` FIRST in the key. Mainnet and testnet cannot collide, and a query that forgot to filter
  -- by network cannot be written by accident.
  PRIMARY KEY (network, tx_hash, log_index),

  CONSTRAINT raw_chain_events_status_known CHECK (status IN ('LIVE', 'ORPHANED')),
  CONSTRAINT raw_chain_events_orphan_dated CHECK (status <> 'ORPHANED' OR orphaned_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS raw_chain_events_by_block ON raw_chain_events (network, block_number);
CREATE INDEX IF NOT EXISTS raw_chain_events_by_address ON raw_chain_events (network, address, block_number DESC);
CREATE INDEX IF NOT EXISTS raw_chain_events_undecoded
  ON raw_chain_events (network, block_number)
  WHERE decoded IS NULL AND status = 'LIVE';

-- One transaction, and what this system believes about it.
CREATE TABLE IF NOT EXISTS indexed_transactions (
  network         TEXT        NOT NULL,
  tx_hash         TEXT        NOT NULL,

  block_number    BIGINT      NOT NULL,
  block_hash      TEXT        NOT NULL,
  block_time      TIMESTAMPTZ,
  from_address    TEXT,
  to_address      TEXT,
  value_wei       TEXT,
  gas_used        TEXT,
  gas_price_wei   TEXT,
  success         BOOLEAN,

  -- RECONCILED       — a case claims it and the linkage is recorded.
  -- UNRECONCILED     — it touches a watched address and nothing claims it. Something moved money and
  --                    this system cannot say why.
  -- SHADOW_EXECUTION — it looks like an execution and reconciles to no intent. Not merely unexplained:
  --                    shaped like something this system is supposed to be the only source of.
  -- IGNORED          — deliberately out of scope, with the reason in `classification_note`. A state
  --                    that exists so "we looked and decided it does not matter" is distinguishable
  --                    from "nobody looked".
  reconciliation  TEXT        NOT NULL DEFAULT 'UNRECONCILED',
  classification_note TEXT,

  status          TEXT        NOT NULL DEFAULT 'LIVE',
  orphaned_at     TIMESTAMPTZ,

  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (network, tx_hash),

  CONSTRAINT indexed_tx_reconciliation_known
    CHECK (reconciliation IN ('RECONCILED', 'UNRECONCILED', 'SHADOW_EXECUTION', 'IGNORED')),
  CONSTRAINT indexed_tx_status_known CHECK (status IN ('LIVE', 'ORPHANED')),
  -- IGNORED must say why. Without the note it is indistinguishable from a row somebody silenced.
  CONSTRAINT indexed_tx_ignored_explained
    CHECK (reconciliation <> 'IGNORED' OR classification_note IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS indexed_tx_unreconciled
  ON indexed_transactions (network, block_number DESC)
  WHERE reconciliation IN ('UNRECONCILED', 'SHADOW_EXECUTION') AND status = 'LIVE';

-- ─────────────────────────────────────────────────────────────────────────────
-- The case
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_cases (
  case_id          TEXT PRIMARY KEY,
  network          TEXT        NOT NULL,
  -- Present once the case is attributable. NULL is legitimate and common: a watched-address transfer
  -- that reconciles to nothing has no account, and inventing one to satisfy a foreign key would be
  -- worse than the null.
  account_id       TEXT REFERENCES untch_accounts(account_id) ON DELETE SET NULL,

  -- The spine. An intent is what most cases are ABOUT; the rest are context hanging off it.
  intent_id        TEXT,
  policy_id        TEXT,
  approval_request_id TEXT,
  service_order_ref TEXT,
  marketplace_task_ref TEXT,
  receipt_id       TEXT,

  kind             TEXT        NOT NULL,
  state            TEXT        NOT NULL DEFAULT 'OPEN',
  title            TEXT        NOT NULL,

  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT activity_cases_kind_known
    CHECK (kind IN ('spend', 'marketplace-order', 'governance', 'treasury', 'unreconciled')),
  CONSTRAINT activity_cases_state_known CHECK (state IN ('OPEN', 'SETTLED', 'REFUSED', 'ABANDONED')),
  CONSTRAINT activity_cases_closed_dated CHECK (state = 'OPEN' OR closed_at IS NOT NULL)
);

-- One case per intent per network. An intent with two cases would report its money twice.
CREATE UNIQUE INDEX IF NOT EXISTS activity_cases_one_per_intent
  ON activity_cases (network, intent_id)
  WHERE intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS activity_cases_by_account ON activity_cases (account_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS activity_cases_by_state ON activity_cases (network, state, opened_at DESC);

-- One thing that happened, in one case. Internal and on-chain events share this table on purpose:
-- the whole point of a case is that a policy decision and a settlement transaction sit on one
-- timeline, and two tables would mean two timelines a reader has to merge by eye.
CREATE TABLE IF NOT EXISTS activity_events (
  event_id     TEXT PRIMARY KEY,
  case_id      TEXT        NOT NULL REFERENCES activity_cases(case_id) ON DELETE CASCADE,
  network      TEXT        NOT NULL,

  -- 'policy-decision' | 'approval-request' | 'approval-decision' | 'marketplace-payment' |
  -- 'settlement' | 'delivery-verification' | 'receipt-anchor' | 'governance' | 'ledger'.
  kind         TEXT        NOT NULL,
  -- 'outbox' | 'chain' | 'operator'. Where the evidence came from, so a reader can tell an assertion
  -- this system made from a fact a chain recorded.
  source       TEXT        NOT NULL,

  occurred_at  TIMESTAMPTZ NOT NULL,
  summary      TEXT        NOT NULL,

  -- The chain evidence, when there is any.
  tx_hash      TEXT,
  log_index    INTEGER,

  -- Split so a projection cannot leak by accident. `public_detail` is what a shared receipt link may
  -- show; `private_detail` is everything else. One column with a redaction function applied at read
  -- time would mean every new reader is one forgotten call away from publishing an address.
  public_detail  JSONB      NOT NULL DEFAULT '{}'::jsonb,
  private_detail JSONB      NOT NULL DEFAULT '{}'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT activity_events_source_known CHECK (source IN ('outbox', 'chain', 'operator'))
);

CREATE INDEX IF NOT EXISTS activity_events_timeline ON activity_events (case_id, occurred_at, event_id);
-- One chain log produces one event in one case. Without this, a re-run of the backfill would append a
-- duplicate to every timeline it touched — which is exactly what "idempotent backfill" has to mean.
CREATE UNIQUE INDEX IF NOT EXISTS activity_events_one_per_log
  ON activity_events (network, tx_hash, log_index, case_id)
  WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS reconciliation_links (
  link_id     TEXT PRIMARY KEY,
  network     TEXT        NOT NULL,
  tx_hash     TEXT        NOT NULL,
  case_id     TEXT        NOT NULL REFERENCES activity_cases(case_id) ON DELETE CASCADE,
  -- How the link was made. 'intent-hash' and 'receipt-id' are strong; 'address-heuristic' is a guess
  -- and is recorded as one, so a total built on guesses can be told apart from a total built on proof.
  method      TEXT        NOT NULL,
  confidence  TEXT        NOT NULL DEFAULT 'exact',
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reconciliation_confidence_known CHECK (confidence IN ('exact', 'heuristic')),
  CONSTRAINT reconciliation_unique UNIQUE (network, tx_hash, case_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Money, split so nothing can be counted as revenue that is not
-- ─────────────────────────────────────────────────────────────────────────────

-- The distinction this table exists for: 105 arrived, 100 belongs to a provider, 5 is the fee, and
-- ONLY the fee (less gas) is revenue. Reporting the 105, or the 100, as Untch's income would be the
-- easiest and most damaging number in the system to get wrong — so the components are separate
-- columns and the total is derived, rather than a single figure with a label.
CREATE TABLE IF NOT EXISTS revenue_allocations (
  allocation_id       TEXT PRIMARY KEY,
  network             TEXT        NOT NULL,
  case_id             TEXT        NOT NULL REFERENCES activity_cases(case_id) ON DELETE CASCADE,
  service_order_ref   TEXT,
  asset               TEXT        NOT NULL,

  -- Every amount is a DECIMAL STRING. A float here would make a total drift in the sixth decimal
  -- place, which is exactly where money reconciliation fails and exactly where nobody looks.
  marketplace_gross   TEXT        NOT NULL DEFAULT '0',
  provider_principal  TEXT        NOT NULL DEFAULT '0',
  untch_service_fee   TEXT        NOT NULL DEFAULT '0',
  provider_fee        TEXT        NOT NULL DEFAULT '0',
  network_gas         TEXT        NOT NULL DEFAULT '0',
  refund              TEXT        NOT NULL DEFAULT '0',
  treasury_funding    TEXT        NOT NULL DEFAULT '0',
  bond_movement       TEXT        NOT NULL DEFAULT '0',

  -- PROVISIONAL — computed from a quote, before settlement confirmed.
  -- RECOGNIZED   — settlement confirmed and the split is final.
  -- UNSETTLED    — money is owed and has not moved. A liability, and it must not read as revenue.
  status              TEXT        NOT NULL DEFAULT 'PROVISIONAL',

  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT revenue_status_known CHECK (status IN ('PROVISIONAL', 'RECOGNIZED', 'UNSETTLED')),
  CONSTRAINT revenue_amounts_decimal CHECK (
    marketplace_gross  ~ '^-?[0-9]{1,24}(\.[0-9]{1,18})?$' AND
    provider_principal ~ '^-?[0-9]{1,24}(\.[0-9]{1,18})?$' AND
    untch_service_fee  ~ '^-?[0-9]{1,24}(\.[0-9]{1,18})?$' AND
    provider_fee       ~ '^-?[0-9]{1,24}(\.[0-9]{1,18})?$' AND
    network_gas        ~ '^-?[0-9]{1,24}(\.[0-9]{1,18})?$' AND
    refund             ~ '^-?[0-9]{1,24}(\.[0-9]{1,18})?$'
  ),
  CONSTRAINT revenue_one_per_case UNIQUE (network, case_id, asset)
);

CREATE INDEX IF NOT EXISTS revenue_by_status ON revenue_allocations (network, status, computed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Service orders
-- ─────────────────────────────────────────────────────────────────────────────

-- The marketplace order, and everything it turned into. One row is the join between a purchase made
-- on OKX and the intent, execution, delivery and receipt it produced here — the reconciliation that
-- was impossible before an account existed to hang both ends off.
CREATE TABLE IF NOT EXISTS service_orders (
  service_order_id  TEXT PRIMARY KEY,
  network           TEXT        NOT NULL,
  marketplace       TEXT        NOT NULL,
  -- The marketplace's own order id. Unique per marketplace: two rows for one order would double it.
  marketplace_order_ref TEXT    NOT NULL,
  account_id        TEXT REFERENCES untch_accounts(account_id) ON DELETE SET NULL,

  task_ref          TEXT,
  policy_id         TEXT,
  intent_id         TEXT,
  execution_id      TEXT,
  delivery_ref      TEXT,
  receipt_id        TEXT,
  case_id           TEXT REFERENCES activity_cases(case_id) ON DELETE SET NULL,

  -- What the marketplace says was paid, kept as a decimal string beside the asset it was paid in.
  marketplace_payment_amount TEXT,
  marketplace_payment_asset  TEXT,
  marketplace_payment_tx     TEXT,

  state             TEXT        NOT NULL DEFAULT 'OPEN',
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT service_orders_state_known
    CHECK (state IN ('OPEN', 'DELIVERED', 'REFUNDED', 'DISPUTED', 'ABANDONED')),
  CONSTRAINT service_orders_unique_ref UNIQUE (marketplace, marketplace_order_ref)
);

CREATE INDEX IF NOT EXISTS service_orders_by_account ON service_orders (account_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS service_orders_by_intent ON service_orders (intent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Failures, kept rather than logged
-- ─────────────────────────────────────────────────────────────────────────────

-- An indexer that only logs its failures is an indexer whose gaps are invisible the moment the log
-- rotates. A row survives, can be counted, and can be retried — and `resolved_at` is what stops a
-- fixed problem from being reported forever.
CREATE TABLE IF NOT EXISTS indexer_failures (
  failure_id   TEXT PRIMARY KEY,
  network      TEXT        NOT NULL,
  source_id    TEXT,
  -- 'fetch' | 'decode' | 'reconcile' | 'project'. Which stage, because the fix differs entirely.
  stage        TEXT        NOT NULL,
  block_number BIGINT,
  tx_hash      TEXT,
  message      TEXT        NOT NULL,
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  attempts     INTEGER     NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,

  CONSTRAINT indexer_failures_stage_known CHECK (stage IN ('fetch', 'decode', 'reconcile', 'project'))
);

CREATE INDEX IF NOT EXISTS indexer_failures_open
  ON indexer_failures (network, stage, last_seen_at DESC)
  WHERE resolved_at IS NULL;
