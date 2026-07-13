-- §27 operator-identity — GENUINELY LOAD-BEARING (no longer just seeded placeholders).
--
-- The operator is a first-class row; its channel handles are the persisted (channel, handle) → operator
-- map; and a policy names its approvers through a join table. Now that create_spend_policy gives policies
-- genuine, distinct owners (per-caller ownership), TWO real authority paths read these tables:
--   • escalation ROUTING (services/asp/src/escalation-routing.ts): an escalating policy is routed to its
--     REAL owner's operator (resolved via the owner's `dashboard` binding) and fanned out to THAT
--     operator's bound channels — not a hardcoded operator regardless of owner.
--   • the §27 dashboard authority boundary: a SIWE session may resolve an escalation only if its wallet's
--     operator is an approver of THAT escalation's policy (operatorForOwner + approversFor).
--
-- The interim single operator is provisioned from env at boot; an unbound owner routes to it as the
-- documented interim default. A real §15 onboarding binds an owner to its OWN operator and routing follows
-- it — a second operator is a few INSERTs, never a schema change. Same shared Postgres; this package owns
-- 004. Idempotent (IF NOT EXISTS / ON CONFLICT), safe to re-run.

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
