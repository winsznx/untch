-- PRD §6.2 / §8 / §10.1 — the durable `policies` table, added to the SAME Railway Postgres the
-- receipt writer (§7.4) already provisioned (migration 001_init.sql lives in @untch/receipt-writer;
-- this is 002 in the shared, forward-only `schema_migrations` history). No second instance.
--
-- The defining choice (task "POLICY ID CONSISTENCY"): `id` IS the on-chain PolicyRegistry policyId —
-- uint256(keccak256(abi.encodePacked(owner, ownerNonce))) — NOT an off-chain auto-increment. It is
-- read back from the confirmed PolicyRegistered event, so Postgres and chain share one identity and
-- can never drift. `id` is NUMERIC(78,0) because a uint256 does not fit in BIGINT (same representation
-- the receipt writer uses for `policy_id`).
--
-- Idempotent: guarded with IF NOT EXISTS; the migration runner records applied files so a re-run is a
-- no-op. Postgres is synced FROM the chain — a row is written only after the anchoring tx confirms, so
-- `onchain_ref` is never null for a live row and never claims an anchor that did not land.
CREATE TABLE IF NOT EXISTS policies (
  -- on-chain policyId (uint256) — the shared identity, not a serial.
  id          NUMERIC(78,0) PRIMARY KEY,
  -- registrant / operator wallet (msg.sender of registerPolicy). The only account the contract lets
  -- mutate this policy; also the address whose nonce derived `id`.
  owner       TEXT        NOT NULL,
  -- the agent this policy governs (§10.1 Policy.agent), immutable after registration.
  agent_id    TEXT        NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  -- mirrors the on-chain lifecycle {ACTIVE, PAUSED}. EXPIRED is DERIVED at read time from the rules'
  -- expiry (never a stored state), exactly as PolicyRegistry.isUsable derives it — see repo.rowToPolicy.
  status      TEXT        NOT NULL DEFAULT 'ACTIVE',
  -- keccak of the canonical §9 JSON of `rules`, computed with @untch/canon (Surface A). Equals the
  -- value anchored on-chain — same bytes the MCP server enforces and the registry committed.
  policy_hash TEXT        NOT NULL,
  -- on-chain expiry (unix seconds, uint64) mirrored for cheap reads; the authoritative human copy is
  -- rules->>'expiry' (ISO-8601), which the policy engine reads for its active/expired check.
  expiry      BIGINT      NOT NULL,
  -- proof the row is backed by real chain state: registry address + the register/update/pause txs and
  -- blocks that produced this row's current state. Never null for a live row (§8 `onchain_ref`).
  onchain_ref JSONB       NOT NULL,
  -- the committed ruleset (§8 `policies.rules`), evaluated verbatim by @untch/policy-engine.
  rules       JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policies_agent_idx ON policies (agent_id, created_at);
CREATE INDEX IF NOT EXISTS policies_owner_idx ON policies (owner, created_at);
