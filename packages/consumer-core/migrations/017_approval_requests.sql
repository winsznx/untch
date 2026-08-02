-- An approval that names the exact thing it approves.
--
-- WHAT ALREADY EXISTS, AND WHAT IT DOES NOT COVER
--
-- `@untch/escalation` already runs a channel-neutral lifecycle: PENDING → APPROVED/DENIED/EXPIRED, an
-- authority boundary that every inbound response passes through regardless of transport, a one-time
-- approval code, dual-channel rules, a per-channel audit log. None of that is replaced here and none of
-- it should be — it is the transport and the operator-authority half, and it works.
--
-- What it cannot express is WHAT was approved. An escalation row carries an amount and a token, and the
-- code it checks is a code: it proves the responder held a secret, not that they agreed to a specific
-- payment. So the following is possible today and is exactly what this migration exists to make
-- impossible:
--
--   1. an escalation is raised for a 6.00 quote
--   2. the quote is re-fetched and comes back 6.50 — a different obligation, same intent
--   3. the operator approves, holding a code that was never bound to either number
--
-- WHAT AN APPROVAL IS HERE
--
-- A commitment to one DIGEST, and the digest covers every field that changes what the money does:
-- intent, quote hash, amount, asset, provider, capability, recipient, policy, policy version, nonce and
-- expiry. Re-quote and the digest changes; the old approval no longer matches anything and the request
-- is SUPERSEDED rather than silently reused. That is the property "approve the exact quote" actually
-- needs, and it is a property of a value rather than of a check somebody remembered to write.
--
-- A PLAIN "YES" CANNOT REACH THIS TABLE
--
-- `approval_digest` is NOT NULL on every decision row. A channel adapter that received the word "yes"
-- has nothing to put in that column, so the write fails rather than an approval existing with no
-- subject. The digest is computed server-side from the request and compared, so a channel cannot
-- supply one either — it can only echo the one it was shown.

-- ─────────────────────────────────────────────────────────────────────────────
-- The request
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_approval_requests (
  approval_request_id TEXT PRIMARY KEY,
  account_id          TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,

  -- Everything the digest binds. Stored as columns rather than only inside the digest, because a
  -- digest nobody can explain is a digest nobody can audit — the approval centre has to be able to
  -- show a human what they are agreeing to, in the same fields the hash covers.
  policy_id           TEXT        NOT NULL,
  policy_version      INTEGER     NOT NULL,
  intent_id           TEXT        NOT NULL,
  quote_id            TEXT,
  quote_hash          TEXT        NOT NULL,
  provider            TEXT        NOT NULL,
  capability          TEXT        NOT NULL,
  -- DECIMAL STRING, never a float. The amount is compared, hashed and shown to a person, and a binary
  -- fraction would make those three disagree in the sixth decimal place.
  amount              TEXT        NOT NULL,
  asset               TEXT        NOT NULL,
  -- Where the money goes. NULL is a legitimate state — some capabilities have no deterministic
  -- recipient until execution — and it is DISTINCT from a recipient that is the empty string, which
  -- is why the digest encodes the null case explicitly rather than concatenating.
  recipient           TEXT,

  -- Why the policy asked rather than deciding. Free text for a human, plus the machine-readable rules.
  reason              TEXT        NOT NULL,
  triggering_rules    JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- The value a decision must carry. Computed from the columns above by `approvalDigest`.
  approval_digest     TEXT        NOT NULL,
  -- One nonce per request, inside the digest. Two requests that were otherwise identical — the same
  -- amount to the same recipient a minute apart — would otherwise share a digest, and a decision on
  -- one would satisfy the other.
  nonce               TEXT        NOT NULL,

  -- PENDING            — waiting for a human.
  -- APPROVED           — a decision exists and matches the digest.
  -- REJECTED           — a decision exists and refuses.
  -- EXPIRED            — nobody answered in time. Terminal; an expired request is not re-openable,
  --                      because the quote it named has aged out with it.
  -- SUPERSEDED         — the quote changed. The request is closed and a new one names the new digest.
  -- EXECUTED           — the approved action actually ran.
  --
  -- There is deliberately no state meaning "approved, probably executed". APPROVED is where a request
  -- sits when providers are disabled, and the approval centre says APPROVED_AWAITING_EXECUTION rather
  -- than implying a payment occurred.
  state               TEXT        NOT NULL DEFAULT 'PENDING',

  -- Single-owner approval for now. The column exists so a later guardian quorum is a value change
  -- rather than a schema change, and so today's behaviour is stated rather than assumed to be 1.
  required_quorum     INTEGER     NOT NULL DEFAULT 1,
  decision_count      INTEGER     NOT NULL DEFAULT 0,

  -- When a re-quote closes this request, the replacement is named here. A superseded request that
  -- cannot say what replaced it leaves a timeline with a hole in it.
  superseded_by       TEXT,

  expires_at          TIMESTAMPTZ NOT NULL,
  resolved_at         TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT        NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT        NOT NULL,

  CONSTRAINT untch_approval_state_known
    CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'EXECUTED')),
  -- A resolved request must say when. "APPROVED, at some unknown time" cannot be checked against a
  -- quote expiry, which is the one comparison an approval exists to survive.
  CONSTRAINT untch_approval_resolved_dated
    CHECK (state IN ('PENDING') OR resolved_at IS NOT NULL),
  CONSTRAINT untch_approval_quorum_positive CHECK (required_quorum >= 1),
  -- An amount is a decimal string. The CHECK is here rather than in code because the column is read by
  -- more than one writer and the format is what makes the digest reproducible.
  CONSTRAINT untch_approval_amount_decimal CHECK (amount ~ '^[0-9]{1,18}(\.[0-9]{1,6})?$')
);

-- At most ONE open request per intent. Two live requests for the same intent means two humans could
-- each approve a different amount for one action, and whichever wrote last would win.
CREATE UNIQUE INDEX IF NOT EXISTS untch_approval_one_open_per_intent
  ON untch_approval_requests (intent_id)
  WHERE state = 'PENDING';

CREATE INDEX IF NOT EXISTS untch_approval_by_account ON untch_approval_requests (account_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS untch_approval_pending_expiry ON untch_approval_requests (state, expires_at);
CREATE INDEX IF NOT EXISTS untch_approval_by_digest ON untch_approval_requests (approval_digest);

-- ─────────────────────────────────────────────────────────────────────────────
-- The decision
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_approval_decisions (
  decision_id         TEXT PRIMARY KEY,
  approval_request_id TEXT        NOT NULL REFERENCES untch_approval_requests(approval_request_id) ON DELETE CASCADE,
  account_id          TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,

  -- Where the answer came from, and which binding vouched for the person giving it. The binding id is
  -- kept even after that binding is revoked: the question "who could answer this, at the time" is
  -- answered by the row, not by re-reading a binding that has since changed.
  channel             TEXT        NOT NULL,
  channel_binding_id  TEXT,
  -- The platform identity or wallet address that actually answered.
  actor               TEXT        NOT NULL,

  decision            TEXT        NOT NULL,

  -- NOT NULL, and this is the load-bearing constraint of the whole file. A channel adapter that
  -- received the word "yes" has nothing to put here, so the write fails rather than an approval
  -- existing with no subject.
  approval_digest     TEXT        NOT NULL,

  -- The request that carried the answer, for tracing a decision back through the transport it arrived on.
  correlation_ref     TEXT,
  provenance          JSONB       NOT NULL DEFAULT '{}'::jsonb,

  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT        NOT NULL,

  CONSTRAINT untch_decision_known CHECK (decision IN ('APPROVE', 'REJECT')),
  CONSTRAINT untch_decision_channel_known
    CHECK (channel IN ('dashboard', 'telegram', 'discord', 'email', 'operator'))
);

-- One actor, one answer, per request. A second identical decision is idempotent because it cannot be
-- written twice; a second CONFLICTING decision from the same actor is refused by the same index, which
-- is the behaviour "a conflicting decision is refused" needs to be enforced by rather than checked for.
CREATE UNIQUE INDEX IF NOT EXISTS untch_decision_one_per_actor
  ON untch_approval_decisions (approval_request_id, channel, actor);

CREATE INDEX IF NOT EXISTS untch_decision_by_request ON untch_approval_decisions (approval_request_id, decided_at);
CREATE INDEX IF NOT EXISTS untch_decision_by_account ON untch_approval_decisions (account_id, decided_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Channel delivery attempts
-- ─────────────────────────────────────────────────────────────────────────────

-- Every attempt to REACH a person about a request, whether or not it worked.
--
-- Kept separately from the decision because they answer different questions. A decision says what was
-- agreed; this says whether anybody was ever told. An approval that expired unanswered because the
-- Telegram token was unrotated and no message was ever sent is a different failure from one where the
-- owner saw it and ignored it, and a timeline that cannot distinguish them will blame the wrong party.
CREATE TABLE IF NOT EXISTS untch_approval_deliveries (
  delivery_id         TEXT PRIMARY KEY,
  approval_request_id TEXT        NOT NULL REFERENCES untch_approval_requests(approval_request_id) ON DELETE CASCADE,
  channel             TEXT        NOT NULL,
  channel_binding_id  TEXT,
  -- SENT | SKIPPED | FAILED. SKIPPED carries the reason in `detail` — 'credential-unrotated' is the
  -- one this build emits most, and it must be visible rather than looking like a channel nobody chose.
  outcome             TEXT        NOT NULL,
  detail              TEXT,
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT untch_delivery_outcome_known CHECK (outcome IN ('SENT', 'SKIPPED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS untch_delivery_by_request
  ON untch_approval_deliveries (approval_request_id, attempted_at);
