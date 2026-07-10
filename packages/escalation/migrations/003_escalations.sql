-- PRD §7.2 / §8 `escalations` — the durable record of the operator-approval lifecycle. Lives in the
-- SAME shared Postgres as receipt-writer (001) and policy-store (002); the migration runner records
-- applied filenames in the shared `schema_migrations` table, so this file is numbered 003 to stay
-- globally unique across packages. Idempotent (every statement guards with IF NOT EXISTS), so a
-- partially-applied run is safe to re-run.
--
-- Postgres is the source of truth for an escalation's state. A channel (Telegram now, Photon later)
-- only transports the operator's response; the state machine and the §27 authority-boundary check that
-- gate every transition live here + in the service, NEVER in the channel. Because the timeout clock is
-- derived from `code_expires_at`, an unresolved escalation past that instant reads as EXPIRED → default
-- DENY (I2) even if the BullMQ timeout job never fires — durability of the fail-closed default does not
-- depend on Redis.

CREATE TABLE IF NOT EXISTS escalations (
  -- Escalation id, `esc_<hex>`. Distinct from the poll ref below so the record has its own identity.
  id                  TEXT        PRIMARY KEY,

  -- §8 intent_id — the intentHash the escalated decision was made for. The money is bound to this.
  intent_id          TEXT        NOT NULL,

  -- The key the x402-guard poll handle resolves by: `receiptRef.receiptId ?? intentHash` — the EXACT
  -- id the guard computes from the same preflight decision (see poll.ts). The buyer polls with this;
  -- the resolver looks the escalation up by it. Unique so a poll never resolves to two escalations.
  poll_ref           TEXT        NOT NULL UNIQUE,

  -- §8 status ∈ PENDING | AWAITING_SECOND_CHANNEL | APPROVED | DENIED | EXPIRED | NOTIFY_FAILED.
  status             TEXT        NOT NULL DEFAULT 'PENDING',

  -- The §7.1 terminal escalation code that created this (e.g. ESCALATED_THRESHOLD). Escalations only
  -- exist for decisions the engine escalated; this records which rule did it (authority-boundary pt 2).
  reason             TEXT        NOT NULL,

  -- §8 policy binding + the money the operator is being asked to approve (DISPLAY units, like §8.2).
  policy_id          TEXT        NOT NULL,
  amount             NUMERIC     NOT NULL,
  token              TEXT        NOT NULL,

  -- §27 approvals config AS IN FORCE AT CREATION (channels, dualChannelAbove, channelCaps). Snapshotted
  -- here so the authority-boundary check judges an inbound against the policy that escalated it — a
  -- policy edited mid-escalation can never retroactively widen or narrow what was already asked.
  approvals          JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- §27 single-use code: only the sha256 hash is stored (the plaintext code lives only in the sent
  -- message / callback payload). TTL = escalation timeout; `code_expires_at` is the authoritative clock.
  approval_code_hash TEXT        NOT NULL,
  code_expires_at    TIMESTAMPTZ NOT NULL,

  -- §8 channel_log — append-only fan-out + inbound events (channel, handle, latency, outcome). Every
  -- notification AND every inbound decision (including IGNORED_* failures) is recorded here: the
  -- approval trail is part of the audit surface (§7.2), and a failed control event is NEVER dropped.
  channel_log        JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- §27 dual-channel bookkeeping — the DISTINCT channels that have contributed a valid confirmation.
  -- Below dualChannelAbove one is enough; above it, two distinct channels are required.
  approved_channels  JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- §8 resolved_by {channel, handle} + resolved_at — set once a terminal decision is reached.
  resolved_by        JSONB,
  resolved_at        TIMESTAMPTZ,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escalations_status_idx    ON escalations (status, created_at);
CREATE INDEX IF NOT EXISTS escalations_intent_idx    ON escalations (intent_id);
-- The "APPROVE <code>" text baseline (§27) carries no id, only the code — resolve it by hash.
CREATE INDEX IF NOT EXISTS escalations_codehash_idx  ON escalations (approval_code_hash);
CREATE INDEX IF NOT EXISTS escalations_expiry_idx    ON escalations (code_expires_at) WHERE status IN ('PENDING','AWAITING_SECOND_CHANNEL','NOTIFY_FAILED');
