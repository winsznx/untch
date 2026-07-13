-- §27 operator-identity readiness (schema-readiness only — NOT a multi-approver feature yet).
--
-- Today the §27 authority boundary binds ONE operator via env config (interim{Telegram,Discord,Slack}
-- Binding, combined). That works, but a policy cannot reference an operator, so adding a second approver
-- later would be a migration. These three tables remove that: the operator becomes a first-class row, its
-- channel handles become the persisted (channel, handle) → operator map, and a policy names its approvers
-- through a join table. A second approver later is then a few INSERTs, never a schema change.
--
-- IMPORTANT: nothing reads these for authority yet. The live binding check still uses the env-derived
-- combineBindings (unchanged). These tables are provisioned with exactly today's single operator so the
-- shape is ready when the real §15 dashboard onboarding/binding flow lands. Same shared Postgres; this
-- package owns 004. Idempotent (IF NOT EXISTS / ON CONFLICT), safe to re-run.

-- The operator identity. One person; the real binding tuple (verified wallet, last-verified-at, set by a
-- code roundtrip) is added when §15 exists — for now just an id + label.
CREATE TABLE IF NOT EXISTS escalation_operators (
  id         TEXT        PRIMARY KEY,
  label      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The (channel, handle) → operator map — the thing that was missing. A handle is bound to exactly one
-- operator per channel (PRIMARY KEY on channel+handle), so a lookup by an inbound (channel, handle) is
-- unambiguous. This is the persisted form of what interim{Telegram,Discord,Slack}Binding does in code.
CREATE TABLE IF NOT EXISTS escalation_operator_bindings (
  operator_id TEXT        NOT NULL REFERENCES escalation_operators(id) ON DELETE CASCADE,
  channel     TEXT        NOT NULL,
  handle      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, handle)
);
CREATE INDEX IF NOT EXISTS escalation_operator_bindings_op_idx ON escalation_operator_bindings (operator_id);

-- Which operators may approve a given policy's escalations. v1 scope = exactly one row per policy (the one
-- demo operator). A second approver later is: INSERT the operator, INSERT its bindings, INSERT a row here.
-- policy_id is plain TEXT (no cross-package FK — mirrors escalations.policy_id), referencing the policy id
-- the policy-store owns.
CREATE TABLE IF NOT EXISTS policy_approvers (
  policy_id   TEXT        NOT NULL,
  operator_id TEXT        NOT NULL REFERENCES escalation_operators(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, operator_id)
);
CREATE INDEX IF NOT EXISTS policy_approvers_operator_idx ON policy_approvers (operator_id);

-- Seed the single interim demo operator (the same Step-5 wallet operator the env binds to). Its channel
-- bindings are provisioned from env at service boot (idempotent), and a policy_approvers row is ensured
-- for each policy when it escalates — so the tables carry today's exact single-approver reality.
INSERT INTO escalation_operators (id, label)
VALUES ('op_demo', 'interim demo operator (Step-5 wallet)')
ON CONFLICT (id) DO NOTHING;
