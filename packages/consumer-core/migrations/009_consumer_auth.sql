-- 009_consumer_auth.sql
--
-- Ownership proof for tenant-scoped consumer reads.
--
-- WHAT WAS WRONG. Tenant scope came from `?policyId=`, and `tenantFor(policyId)` turned it into
-- `policy:<id>`. The comment in handlers.ts justified this by saying a policy id is bound to an owner
-- wallet on chain, so a caller could not claim another tenant's scope with a header. That reasoning
-- has a hole the activation audit already flagged: the binding is real, but it is never CHECKED at
-- request time, and a policy id is public on-chain data. Anyone who reads a policy id off the
-- explorer could pass it and receive that tenant's intent amounts, provider, decisions, and — via
-- SSE — their whole lifecycle in real time.
--
-- WHAT THIS ADDS. A nonce table, so a caller can prove control of the policy owner's wallet with
-- SIWE. The nonce is issued by the server, single-use, and expiring — the three properties that make
-- a signature un-replayable. Without server-issued nonces, a signature captured once works forever.
--
-- The session token itself is NOT stored. It is a short-lived HMAC-signed bearer derived from a
-- verified signature, so a stolen token expires on its own and revocation is a secret rotation. A
-- session table would add a write to every request to defend against a window measured in minutes.

CREATE TABLE IF NOT EXISTS consumer_auth_nonces (
  nonce       TEXT        PRIMARY KEY,
  -- The address that requested it, when the caller declared one. Advisory: the binding that matters
  -- is enforced at verify time against the signature, not against this column.
  address     TEXT,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- Set exactly once, by a conditional UPDATE. Single-use is enforced by that update affecting zero
  -- rows the second time, not by a read-then-write that two concurrent requests could both pass.
  consumed_at TIMESTAMPTZ
);

-- The sweeper's working set: expired and unconsumed.
CREATE INDEX IF NOT EXISTS consumer_auth_nonces_expiry_idx
  ON consumer_auth_nonces (expires_at)
  WHERE consumed_at IS NULL;
