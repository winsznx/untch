-- Untch Consumer Pack — the durable schema for governed consumer execution.
--
-- Lives in the SAME shared Railway Postgres as receipt-writer (001), policy-store (002), escalation
-- (003/004) and trust-bureau (006). This is 007 in the shared, forward-only `schema_migrations`
-- history; the runner takes the same advisory lock (4021_1003) so no two migrators ever race.
-- Idempotent (every statement guards with IF NOT EXISTS), so a partially-applied run is safe to re-run.
--
-- The design rule throughout: an invariant that CAN be expressed in SQL IS expressed in SQL. A
-- uniqueness constraint that lives only in application code is an invariant that holds until the
-- day two workers run at once. The three that matter most are enforced here as unique indexes:
--
--   • one funding receipt can never fund two intents          → funding_receipts.intent_id UNIQUE
--   • one on-chain payment can never be counted twice         → (chain, tx_hash) UNIQUE
--   • one provider execution can never be sent twice          → (provider_id, idempotency_key) UNIQUE
--
-- And the ledger is append-only by RULE, not by convention: UPDATE and DELETE on consumer_ledger_entries
-- are rejected by the database, so a correction must be a reversing entry that stays visible.

-- ── provider registry ───────────────────────────────────────────────────────────────────────────
-- The ONLY source of a provider base URL. Nothing user-supplied ever becomes a fetch target; this is
-- the SSRF control expressed as data ownership rather than as a validation someone must remember.
CREATE TABLE IF NOT EXISTS consumer_providers (
  provider_id   TEXT        PRIMARY KEY,
  display_name  TEXT        NOT NULL,
  -- verified: a real settled payment has been observed from an Untch treasury wallet AND delivery
  --           was verified. ONLY these may execute on a production route.
  -- sandbox:  adapter implemented + schemas validated against the live spec, NO live settlement.
  -- experimental: reachable but a required leg is unverified (SIWX identity, an unsettleable rail).
  -- disabled: not integrated; cannot be selected at all.
  maturity      TEXT        NOT NULL DEFAULT 'disabled'
                CHECK (maturity IN ('verified','sandbox','experimental','disabled')),
  base_url      TEXT        NOT NULL,
  -- x402 | mpp | siwx | none — how the provider gates its paid endpoints.
  protocol      TEXT        NOT NULL,
  -- CAIP-2 chains this provider will accept settlement on, as observed in its real challenges.
  chains        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Free-text, operator-owned: what was actually observed, when, and from where.
  provenance    TEXT        NOT NULL DEFAULT '',
  enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumer_provider_capabilities (
  provider_id  TEXT        NOT NULL REFERENCES consumer_providers(provider_id) ON DELETE CASCADE,
  capability   TEXT        NOT NULL,
  -- A capability may be less mature than its provider (e.g. StableDomains is sandbox for `check`
  -- but experimental for `dns`, which needs a SIWX identity we do not hold). Never MORE mature —
  -- enforced in the registry, since SQL cannot compare against the parent row cheaply here.
  maturity     TEXT        NOT NULL DEFAULT 'disabled'
               CHECK (maturity IN ('verified','sandbox','experimental','disabled')),
  notes        TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, capability)
);

CREATE TABLE IF NOT EXISTS consumer_provider_health (
  id             BIGSERIAL   PRIMARY KEY,
  provider_id    TEXT        NOT NULL REFERENCES consumer_providers(provider_id) ON DELETE CASCADE,
  healthy        BOOLEAN     NOT NULL,
  latency_ms     INTEGER,
  http_status    INTEGER,
  detail         TEXT        NOT NULL DEFAULT '',
  -- circuit breaker: CLOSED (normal) | OPEN (refusing) | HALF_OPEN (one probe allowed)
  breaker_state  TEXT        NOT NULL DEFAULT 'CLOSED'
                 CHECK (breaker_state IN ('CLOSED','OPEN','HALF_OPEN')),
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumer_provider_health_idx
  ON consumer_provider_health (provider_id, observed_at DESC);

-- ── kill switches ───────────────────────────────────────────────────────────────────────────────
-- One table for every pause scope so an operator has exactly one place to look, and the executor has
-- exactly one query to run. `scope` ∈ GLOBAL | PROVIDER | CHAIN | ASSET | TREASURY_ACCOUNT.
CREATE TABLE IF NOT EXISTS consumer_pause_flags (
  scope       TEXT        NOT NULL CHECK (scope IN ('GLOBAL','PROVIDER','CHAIN','ASSET','TREASURY_ACCOUNT')),
  target      TEXT        NOT NULL DEFAULT '*',
  paused      BOOLEAN     NOT NULL DEFAULT TRUE,
  reason      TEXT        NOT NULL DEFAULT '',
  set_by      TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target)
);

-- ── consumer intents ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumer_intents (
  intent_id            TEXT        PRIMARY KEY,
  tenant_id            TEXT        NOT NULL,
  requesting_agent_id  TEXT        NOT NULL,
  principal_id         TEXT        NOT NULL,
  action               TEXT        NOT NULL,
  category             TEXT        NOT NULL,
  provider_id          TEXT        REFERENCES consumer_providers(provider_id),
  request              JSONB       NOT NULL DEFAULT '{}'::jsonb,

  policy_id            TEXT        NOT NULL,
  policy_version       INTEGER,
  policy_hash          TEXT,
  -- The §8.2 decision object, stored verbatim. Never re-derived, never edited.
  policy_decision      JSONB,

  quote_id             TEXT,
  quote_hash           TEXT,
  quote_expires_at     TIMESTAMPTZ,

  -- Money is stored as (atomic NUMERIC, token, contract, chain, decimals) — never as a bare number,
  -- so a row is self-describing and cannot be misread by a consumer that assumes the wrong decimals.
  funding_amount       NUMERIC(78,0),
  funding_token        TEXT,
  funding_contract     TEXT,
  funding_chain        TEXT,
  funding_decimals     SMALLINT,

  settlement_amount    NUMERIC(78,0),
  settlement_token     TEXT,
  settlement_contract  TEXT,
  settlement_chain     TEXT,
  settlement_decimals  SMALLINT,

  untch_fee_amount     NUMERIC(78,0),
  spread_amount        NUMERIC(78,0),
  max_authorised       NUMERIC(78,0),

  approval_required    BOOLEAN     NOT NULL DEFAULT FALSE,
  approval_outcome     TEXT        CHECK (approval_outcome IN ('PENDING','APPROVED','DENIED','EXPIRED')),

  state                TEXT        NOT NULL DEFAULT 'CREATED' CHECK (state IN (
                         'CREATED','DISCOVERING','QUOTED','POLICY_CHECKING','BLOCKED',
                         'AWAITING_APPROVAL','APPROVED','AWAITING_FUNDING','FUNDED','EXECUTION_QUEUED',
                         'PROVIDER_PAYMENT_PENDING','PROVIDER_PAID','PROVIDER_ACKNOWLEDGED',
                         'DELIVERY_PENDING','DELIVERY_VERIFIED','COMPLETED','FAILED_BEFORE_PAYMENT',
                         'FAILED_AFTER_PAYMENT','REFUND_PENDING','REFUNDED','MANUAL_REVIEW',
                         'EXPIRED','CANCELLED')),
  failure_code         TEXT,
  failure_detail       TEXT,

  correlation_id       TEXT        NOT NULL,
  idempotency_key      TEXT        NOT NULL,
  -- The §8.1 intentHash this action was projected onto for policy evaluation. Ties the two models.
  spend_intent_hash    TEXT,
  -- The §7.4 receipt id, once the completed action has been recorded.
  receipt_id           TEXT,
  -- Monotonic per-intent event counter; the outbox's seq is assigned from here in the same tx.
  event_seq            INTEGER     NOT NULL DEFAULT 0,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ
);

-- Duplicate protection AND tenant isolation in one constraint: two tenants may legitimately send the
-- same key, and must never collide.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_intents_idem_idx
  ON consumer_intents (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS consumer_intents_state_idx  ON consumer_intents (state, created_at);
CREATE INDEX IF NOT EXISTS consumer_intents_tenant_idx ON consumer_intents (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS consumer_intents_agent_idx  ON consumer_intents (requesting_agent_id, created_at DESC);
-- The expiry sweeper's working set. Partial so it stays small as history grows.
CREATE INDEX IF NOT EXISTS consumer_intents_expiry_idx ON consumer_intents (expires_at)
  WHERE state IN ('CREATED','DISCOVERING','QUOTED','POLICY_CHECKING','AWAITING_APPROVAL',
                  'APPROVED','AWAITING_FUNDING');
-- The manual-review queue.
CREATE INDEX IF NOT EXISTS consumer_intents_review_idx ON consumer_intents (updated_at)
  WHERE state = 'MANUAL_REVIEW';

-- ── quotes (immutable) ──────────────────────────────────────────────────────────────────────────
-- A re-quote is a NEW row. Nothing here is ever UPDATEd: an approval binds to `quote_hash`, and a
-- mutable quote would silently re-scope an approval a human already gave.
CREATE TABLE IF NOT EXISTS consumer_quotes (
  quote_id              TEXT        PRIMARY KEY,
  intent_id             TEXT        NOT NULL REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  provider_id           TEXT        NOT NULL REFERENCES consumer_providers(provider_id),
  provider_ref          TEXT        NOT NULL,

  provider_cost         NUMERIC(78,0) NOT NULL,
  settlement_token      TEXT        NOT NULL,
  settlement_contract   TEXT,
  settlement_chain      TEXT        NOT NULL,
  settlement_decimals   SMALLINT    NOT NULL,
  settlement_recipient  TEXT        NOT NULL,

  untch_fee             NUMERIC(78,0) NOT NULL,
  spread                NUMERIC(78,0) NOT NULL,
  total_user_amount     NUMERIC(78,0) NOT NULL,
  max_authorised        NUMERIC(78,0) NOT NULL,
  funding_token         TEXT        NOT NULL,
  funding_contract      TEXT,
  funding_chain         TEXT        NOT NULL,
  funding_decimals      SMALLINT    NOT NULL,

  summary               TEXT        NOT NULL DEFAULT '',
  terms                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  quote_hash            TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS consumer_quotes_intent_idx ON consumer_quotes (intent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS consumer_quotes_hash_idx ON consumer_quotes (quote_hash);

-- ── approvals ───────────────────────────────────────────────────────────────────────────────────
-- Binds the escalation record to EXACTLY what was approved. Every column here is re-checked
-- immediately before the provider is paid, so a policy edit or a re-quote invalidates the approval
-- rather than silently widening it.
CREATE TABLE IF NOT EXISTS consumer_approvals (
  intent_id             TEXT        PRIMARY KEY REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  escalation_id         TEXT        NOT NULL,
  poll_ref              TEXT        NOT NULL,
  required              BOOLEAN     NOT NULL DEFAULT TRUE,
  outcome               TEXT        NOT NULL DEFAULT 'PENDING'
                        CHECK (outcome IN ('PENDING','APPROVED','DENIED','EXPIRED')),
  quote_hash            TEXT        NOT NULL,
  policy_id             TEXT        NOT NULL,
  policy_version        INTEGER     NOT NULL,
  policy_hash           TEXT        NOT NULL,
  max_amount            NUMERIC(78,0) NOT NULL,
  max_amount_token      TEXT        NOT NULL,
  max_amount_chain      TEXT        NOT NULL,
  max_amount_decimals   SMALLINT    NOT NULL,
  settlement_recipient  TEXT        NOT NULL,
  settlement_chain      TEXT        NOT NULL,
  provider_id           TEXT        NOT NULL,
  resolved_by           JSONB,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS consumer_approvals_pollref_idx ON consumer_approvals (poll_ref);

-- ── funding receipts ────────────────────────────────────────────────────────────────────────────
-- The two constraints that make double-funding impossible rather than unlikely.
CREATE TABLE IF NOT EXISTS consumer_funding_receipts (
  intent_id      TEXT        PRIMARY KEY REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  chain          TEXT        NOT NULL,
  tx_hash        TEXT        NOT NULL,
  amount         NUMERIC(78,0) NOT NULL,
  token          TEXT        NOT NULL,
  contract       TEXT,
  decimals       SMALLINT    NOT NULL,
  payer          TEXT,
  confirmations  INTEGER     NOT NULL DEFAULT 0,
  finalized      BOOLEAN     NOT NULL DEFAULT FALSE,
  settled_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One on-chain payment can only ever be counted once, across all intents.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_funding_tx_idx
  ON consumer_funding_receipts (chain, lower(tx_hash));

-- ── provider executions ─────────────────────────────────────────────────────────────────────────
-- One row per ATTEMPT, written BEFORE the outbound request leaves. That ordering is the whole point:
-- a process that dies mid-request leaves a PREPARED/SENT row behind, so an ambiguous outcome is
-- always visible to the reconciler instead of vanishing with the process.
CREATE TABLE IF NOT EXISTS consumer_provider_executions (
  execution_id       TEXT        PRIMARY KEY,
  intent_id          TEXT        NOT NULL REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  provider_id        TEXT        NOT NULL REFERENCES consumer_providers(provider_id),
  attempt_no         INTEGER     NOT NULL,
  idempotency_key    TEXT        NOT NULL,
  state              TEXT        NOT NULL DEFAULT 'PREPARED'
                     CHECK (state IN ('PREPARED','SENT','PAID','ACKNOWLEDGED','FAILED','AMBIGUOUS')),
  provider_reference TEXT,
  settlement_tx_hash TEXT,
  settlement_chain   TEXT,
  settled_amount     NUMERIC(78,0),
  settled_token      TEXT,
  settled_decimals   SMALLINT,
  error              JSONB,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS consumer_exec_attempt_idx
  ON consumer_provider_executions (intent_id, attempt_no);
-- The duplicate-purchase guard: the same idempotency key can never be sent to a provider twice.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_exec_idem_idx
  ON consumer_provider_executions (provider_id, idempotency_key);
CREATE INDEX IF NOT EXISTS consumer_exec_ambiguous_idx
  ON consumer_provider_executions (started_at) WHERE state IN ('SENT','AMBIGUOUS');

-- ── delivery evidence ───────────────────────────────────────────────────────────────────────────
-- provider_attested is the merchant's word; untch_verified is what Untch independently confirmed.
-- Two columns, never merged: collapsing them would make "verified" mean "the merchant said so".
CREATE TABLE IF NOT EXISTS consumer_delivery_evidence (
  intent_id          TEXT        PRIMARY KEY REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  provider_id        TEXT        NOT NULL,
  provider_attested  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  untch_verified     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  verified           BOOLEAN     NOT NULL DEFAULT FALSE,
  method             TEXT        NOT NULL DEFAULT 'NONE',
  evidence_hash      TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── treasury ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumer_treasury_accounts (
  treasury_ref     TEXT        PRIMARY KEY,
  chain            TEXT        NOT NULL,
  token            TEXT        NOT NULL,
  contract         TEXT,
  decimals         SMALLINT    NOT NULL,
  -- FUNDING (receives user payments) | SETTLEMENT (pays providers)
  purpose          TEXT        NOT NULL CHECK (purpose IN ('FUNDING','SETTLEMENT')),
  -- PUBLIC address only. A private key is NEVER stored in Postgres; it lives in the process env and
  -- is reachable only from inside a rail client, never from an adapter.
  address          TEXT        NOT NULL,
  min_balance      NUMERIC(78,0) NOT NULL DEFAULT 0,
  daily_limit      NUMERIC(78,0) NOT NULL DEFAULT 0,
  enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS consumer_treasury_scope_idx
  ON consumer_treasury_accounts (chain, token, purpose);

-- An OBSERVATION of what the chain says, not an authority. Internal position is always SUM(ledger).
CREATE TABLE IF NOT EXISTS consumer_treasury_balances (
  id            BIGSERIAL   PRIMARY KEY,
  treasury_ref  TEXT        NOT NULL REFERENCES consumer_treasury_accounts(treasury_ref) ON DELETE CASCADE,
  onchain       NUMERIC(78,0) NOT NULL,
  ledger        NUMERIC(78,0) NOT NULL,
  drift         NUMERIC(78,0) NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumer_treasury_balances_idx
  ON consumer_treasury_balances (treasury_ref, observed_at DESC);

-- Per-provider spend caps, evaluated inside the same transaction that mints a payment capability.
CREATE TABLE IF NOT EXISTS consumer_provider_limits (
  provider_id    TEXT        NOT NULL REFERENCES consumer_providers(provider_id) ON DELETE CASCADE,
  chain          TEXT        NOT NULL,
  token          TEXT        NOT NULL,
  per_tx_max     NUMERIC(78,0) NOT NULL,
  daily_max      NUMERIC(78,0) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, chain, token)
);

-- A minted capability. `consumed_at` is set under a row lock, which is what makes a capability
-- single-use even if two workers race on the same intent.
CREATE TABLE IF NOT EXISTS consumer_payment_capabilities (
  capability_id  TEXT        PRIMARY KEY,
  intent_id      TEXT        NOT NULL REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  provider_id    TEXT        NOT NULL,
  treasury_ref   TEXT        NOT NULL REFERENCES consumer_treasury_accounts(treasury_ref),
  chain          TEXT        NOT NULL,
  token          TEXT        NOT NULL,
  contract       TEXT,
  decimals       SMALLINT    NOT NULL,
  max_amount     NUMERIC(78,0) NOT NULL,
  recipients     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  spent_amount   NUMERIC(78,0)
);
-- At most one live capability per intent: a second mint is a bug, not a fallback.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_capability_intent_idx
  ON consumer_payment_capabilities (intent_id) WHERE consumed_at IS NULL;

-- ── double-entry ledger (append-only) ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumer_ledger_accounts (
  account_id  TEXT        PRIMARY KEY,
  kind        TEXT        NOT NULL CHECK (kind IN (
                'TREASURY','USER_OBLIGATION','PROVIDER_SETTLEMENT','FEE_REVENUE','SPREAD_REVENUE',
                'COST_OF_GOODS','REFUND_PAYABLE','CROSS_RAIL_CLEARING','SUSPENSE')),
  chain       TEXT        NOT NULL,
  token       TEXT        NOT NULL,
  contract    TEXT,
  decimals    SMALLINT    NOT NULL,
  owner_ref   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumer_ledger_accounts_kind_idx ON consumer_ledger_accounts (kind, owner_ref);

CREATE TABLE IF NOT EXISTS consumer_ledger_groups (
  group_id    TEXT        PRIMARY KEY,
  kind        TEXT        NOT NULL CHECK (kind IN
                ('FUNDING','SETTLEMENT','RECOGNITION','REFUND','SUSPENSE_MOVE','ADJUSTMENT')),
  intent_id   TEXT        NOT NULL,
  chain       TEXT        NOT NULL,
  token       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumer_ledger_groups_intent_idx ON consumer_ledger_groups (intent_id, created_at);
-- Each kind of group happens at most once per intent (an ADJUSTMENT is the escape hatch and is
-- deliberately excluded). This is what makes "no intent is executed twice" checkable against money
-- rather than against status.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_ledger_group_once_idx
  ON consumer_ledger_groups (intent_id, kind) WHERE kind <> 'ADJUSTMENT';

CREATE TABLE IF NOT EXISTS consumer_ledger_entries (
  id          BIGSERIAL   PRIMARY KEY,
  group_id    TEXT        NOT NULL REFERENCES consumer_ledger_groups(group_id),
  account_id  TEXT        NOT NULL REFERENCES consumer_ledger_accounts(account_id),
  -- Signed: positive = debit, negative = credit. Zero rows are rejected — an entry that moves
  -- nothing is either a bug or noise in an audit trail.
  amount      NUMERIC(78,0) NOT NULL CHECK (amount <> 0),
  token       TEXT        NOT NULL,
  chain       TEXT        NOT NULL,
  decimals    SMALLINT    NOT NULL,
  memo        TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumer_ledger_entries_account_idx ON consumer_ledger_entries (account_id, id);
CREATE INDEX IF NOT EXISTS consumer_ledger_entries_group_idx   ON consumer_ledger_entries (group_id);

-- Append-only, enforced by the database. A correction is a reversing entry that stays visible; it is
-- never an edit that makes the original disappear. Rules (not triggers) so this costs nothing at
-- insert time and cannot be bypassed by a direct psql session.
DROP RULE IF EXISTS consumer_ledger_entries_no_update ON consumer_ledger_entries;
CREATE RULE consumer_ledger_entries_no_update AS
  ON UPDATE TO consumer_ledger_entries DO INSTEAD NOTHING;
DROP RULE IF EXISTS consumer_ledger_entries_no_delete ON consumer_ledger_entries;
CREATE RULE consumer_ledger_entries_no_delete AS
  ON DELETE TO consumer_ledger_entries DO INSTEAD NOTHING;

-- ── outbox + delivered events ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumer_outbox (
  event_id       TEXT        PRIMARY KEY,
  intent_id      TEXT        NOT NULL REFERENCES consumer_intents(intent_id) ON DELETE CASCADE,
  tenant_id      TEXT        NOT NULL,
  seq            INTEGER     NOT NULL,
  name           TEXT        NOT NULL,
  state          TEXT        NOT NULL,
  correlation_id TEXT        NOT NULL,
  data           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  dispatched     BOOLEAN     NOT NULL DEFAULT FALSE,
  attempts       INTEGER     NOT NULL DEFAULT 0,
  last_error     TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Per-intent monotonic, gapless. This is what makes Last-Event-ID resume exact.
CREATE UNIQUE INDEX IF NOT EXISTS consumer_outbox_seq_idx ON consumer_outbox (intent_id, seq);
-- The dispatcher's working set. Partial so it stays small forever.
CREATE INDEX IF NOT EXISTS consumer_outbox_pending_idx ON consumer_outbox (occurred_at)
  WHERE dispatched = FALSE;

CREATE TABLE IF NOT EXISTS consumer_webhook_endpoints (
  endpoint_id  TEXT        PRIMARY KEY,
  tenant_id    TEXT        NOT NULL,
  url          TEXT        NOT NULL,
  -- The HMAC secret. Stored here because it must be readable to sign; it is not a wallet key and
  -- grants no spending authority.
  secret       TEXT        NOT NULL,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumer_webhook_tenant_idx ON consumer_webhook_endpoints (tenant_id);

CREATE TABLE IF NOT EXISTS consumer_webhook_deliveries (
  id           BIGSERIAL   PRIMARY KEY,
  endpoint_id  TEXT        NOT NULL REFERENCES consumer_webhook_endpoints(endpoint_id) ON DELETE CASCADE,
  event_id     TEXT        NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  delivered    BOOLEAN     NOT NULL DEFAULT FALSE,
  last_status  INTEGER,
  last_error   TEXT,
  next_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS consumer_webhook_once_idx ON consumer_webhook_deliveries (endpoint_id, event_id);
CREATE INDEX IF NOT EXISTS consumer_webhook_due_idx ON consumer_webhook_deliveries (next_at)
  WHERE delivered = FALSE;

-- ── idempotency ─────────────────────────────────────────────────────────────────────────────────
-- PRIMARY KEY (tenant_id, key) makes a cross-tenant collision impossible at the storage layer, not
-- merely unlikely in the derivation.
CREATE TABLE IF NOT EXISTS consumer_idempotency_records (
  tenant_id    TEXT        NOT NULL,
  key          TEXT        NOT NULL,
  intent_id    TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  request_hash TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX IF NOT EXISTS consumer_idempotency_intent_idx ON consumer_idempotency_records (intent_id);
