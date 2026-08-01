-- Finish the account: a binding you can name, revoke, and scope — and the request that creates one.
--
-- WHAT 015 LEFT OPEN
--
-- 015 established that authority comes from a verified wallet and that everything else hangs off an
-- account as a binding. It modelled each binding as a row keyed by its natural identity — an address,
-- an agent id — which is right for uniqueness and wrong for three things the product now needs:
--
--   • a binding cannot be NAMED. `primaryWalletBindingId` has nothing to point at, an audit line has to
--     quote an address to refer to a proof, and a revocation endpoint has no id to take.
--   • a binding cannot be REVOKED. The only way to end one was to delete the row, which deletes the
--     evidence that it ever existed — and the evidence is the part a dispute needs.
--   • a binding cannot be SCOPED. A wallet that proved identity and a wallet permitted to authorise
--     spending were the same row, so the two could never be told apart.
--
-- All three are added here, additively. No column is dropped, no primary key changes, and every row
-- 015 wrote keeps working: `binding_id` is backfilled, `status` defaults to ACTIVE, and `scopes`
-- defaults to the scope those rows already had in practice.
--
-- WHY REVOCATION IS A COLUMN AND NOT A DELETE
--
-- A revoked binding is the answer to "who could have authorised this, and until when". Deleting it
-- makes an old receipt unexplainable: the intent names an account, the account has no wallet that
-- could have signed for it, and nothing records that one ever did. So revocation moves a row from
-- ACTIVE to REVOKED and stamps the time. The uniqueness that matters — one active binding per address —
-- is then enforced by a PARTIAL unique index over ACTIVE rows only, so an address can be re-bound after
-- a genuine revocation without the old proof being erased to make room.

-- ─────────────────────────────────────────────────────────────────────────────
-- The account, completed
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_accounts
  -- Which binding IS this account's authority. A pointer rather than a `role='primary'` scan, because
  -- "the primary" is a decision the account made and a scan only reports a coincidence of flags.
  ADD COLUMN IF NOT EXISTS primary_wallet_binding_id TEXT,
  -- The last time a wallet actually proved itself for this account. Distinct from `updated_at`, which
  -- moves whenever anything at all is written — including by an operator, which is not authentication.
  ADD COLUMN IF NOT EXISTS last_authenticated_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- Wallet bindings: nameable, revocable, scoped
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_wallet_bindings
  ADD COLUMN IF NOT EXISTS binding_id TEXT,
  -- The chain kind says `evm`; this says WHICH evm. A key is the same key on every EVM chain, so the
  -- binding is not per-chain — but the proof was produced against one chain id, and a proof that cannot
  -- say which chain it named cannot be re-checked later.
  ADD COLUMN IF NOT EXISTS proof_chain_id BIGINT,
  -- 'okx-agentic-wallet' | 'injected' | 'unknown'. Recorded because the proof method available depends
  -- on it: personal_sign is documented for the Agentic Wallet, and asserting a method a provider does
  -- not implement is how a linking flow ships broken.
  ADD COLUMN IF NOT EXISTS wallet_provider TEXT NOT NULL DEFAULT 'unknown',
  -- What this binding is ALLOWED to do, not what it happens to be used for. `identity` proves who is
  -- asking. `policy-authority` may act as a policy owner. They are separate because a wallet that
  -- signed a sign-in message has not thereby consented to authorise spending.
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['identity']::TEXT[],
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT;

-- Backfill before the constraints, so a database carrying 015 rows can reach this migration's end state.
UPDATE untch_wallet_bindings
   SET binding_id = 'wbnd_' || encode(sha256((chain_kind || ':' || address)::bytea), 'hex')
 WHERE binding_id IS NULL;

UPDATE untch_wallet_bindings
   SET scopes = ARRAY['identity', 'policy-authority']::TEXT[]
 WHERE role = 'primary' AND scopes = ARRAY['identity']::TEXT[];

ALTER TABLE untch_wallet_bindings
  ALTER COLUMN binding_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE untch_wallet_bindings
    ADD CONSTRAINT untch_wallet_status_known CHECK (status IN ('ACTIVE', 'REVOKED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- A revoked binding must say when. "REVOKED, at some unknown time" cannot answer whether a signature
  -- dated last Tuesday was still valid, which is the only question revocation exists to answer.
  ALTER TABLE untch_wallet_bindings
    ADD CONSTRAINT untch_wallet_revoked_dated CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS untch_wallet_binding_id_unique
  ON untch_wallet_bindings (binding_id);

-- 015's `untch_wallet_one_primary_evm` counts revoked rows, so an account that revoked a wallet could
-- never bind a replacement. The partial index below is the same rule over ACTIVE rows only; the old one
-- is dropped because two indexes disagreeing about the same invariant is worse than either alone.
DROP INDEX IF EXISTS untch_wallet_one_primary_evm;
DROP INDEX IF EXISTS untch_wallet_one_solana;

CREATE UNIQUE INDEX IF NOT EXISTS untch_wallet_one_active_primary_evm
  ON untch_wallet_bindings (account_id)
  WHERE chain_kind = 'evm' AND role = 'primary' AND status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS untch_wallet_one_active_solana
  ON untch_wallet_bindings (account_id)
  WHERE chain_kind = 'solana' AND status = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────────────────────
-- Marketplace bindings: an order, a job, an expiry, a revocation
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_marketplace_bindings
  ADD COLUMN IF NOT EXISTS binding_id TEXT,
  -- The marketplace's own user handle, where it exposes one distinct from the agent id.
  ADD COLUMN IF NOT EXISTS marketplace_user_ref TEXT,
  -- The service order this binding was established through, when it was established through one.
  ADD COLUMN IF NOT EXISTS service_order_ref TEXT,
  ADD COLUMN IF NOT EXISTS task_ref TEXT,
  -- 'wallet-signature' is the only method that produces authority. 'link-code' records that a one-time
  -- code was redeemed — which proves the redeemer held the code, not that they hold the wallet, so it
  -- is stored beside the wallet proof rather than instead of it.
  ADD COLUMN IF NOT EXISTS binding_method TEXT NOT NULL DEFAULT 'unproven',
  -- A marketplace binding may lapse. NULL means it does not expire on its own.
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT;

UPDATE untch_marketplace_bindings
   SET binding_id = 'mbnd_' || encode(sha256((marketplace || ':' || agent_id)::bytea), 'hex')
 WHERE binding_id IS NULL;

UPDATE untch_marketplace_bindings SET binding_method = proven_by WHERE binding_method = 'unproven';

ALTER TABLE untch_marketplace_bindings ALTER COLUMN binding_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE untch_marketplace_bindings
    ADD CONSTRAINT untch_marketplace_status_known CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS untch_marketplace_binding_id_unique
  ON untch_marketplace_bindings (binding_id);

-- One marketplace identity cannot be ACTIVE on two accounts at once. 015's primary key already made
-- the row unique; this makes the ACTIVE row unique, which is the property that survives revocation.
CREATE UNIQUE INDEX IF NOT EXISTS untch_marketplace_one_active
  ON untch_marketplace_bindings (marketplace, agent_id)
  WHERE status = 'ACTIVE';

ALTER TABLE untch_marketplace_jobs
  ADD COLUMN IF NOT EXISTS service_order_ref TEXT,
  ADD COLUMN IF NOT EXISTS source_request_id TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Link requests — a one-time code that authorises a BINDING and never a payment
-- ─────────────────────────────────────────────────────────────────────────────

-- The continuity mechanism. Untch is hired on OKX by a caller Untch has never met; the call carries an
-- agent id, which is a claim. Rather than trusting it or refusing outright, the service answers with a
-- link request: an id, a short-lived one-time code, and a URL where the same person can authenticate
-- with the wallet that actually carries authority.
--
-- WHAT THIS ROW CANNOT DO
--
-- It cannot approve money. There is no amount column, no intent column and no policy column, and the
-- absence is the design: a credential that can both establish identity AND release funds is a
-- credential whose theft does both. Redeeming this code binds a marketplace identity to an account.
-- Spending still requires a policy, a quote, and — above the threshold — an approval whose digest
-- names the exact amount.
--
-- WHY THE CODE IS STORED HASHED
--
-- The row is readable by anything with database access, including a backup, a log drain and a support
-- query. A plaintext one-time code in any of those is a credential in all of them. Only the hash is
-- stored; the code exists in the response body once and is never written down.
CREATE TABLE IF NOT EXISTS untch_account_link_requests (
  link_request_id      TEXT PRIMARY KEY,

  -- NULL until redemption. A link request is created BEFORE anyone has proven who they are — that is
  -- the entire point — so it cannot name an account at creation without inventing one.
  account_id           TEXT REFERENCES untch_accounts(account_id) ON DELETE SET NULL,

  -- sha256 of the one-time code, hex. Never the code.
  code_hash            TEXT        NOT NULL,
  -- The SIWE nonce this request requires the eventual message to name. Binding the two means a
  -- signature obtained for some other purpose cannot be replayed into this link.
  siwe_nonce           TEXT        NOT NULL,

  -- What the redeemer is asking to be able to do. Requested here, GRANTED only on the binding, and the
  -- two are separate rows so an unhonoured request cannot read as a permission.
  requested_scopes     TEXT[]      NOT NULL DEFAULT ARRAY['identity']::TEXT[],

  -- The unproven marketplace context the request arrived with, carried through redemption so the
  -- binding can be created in the same step. Unproven on arrival and unproven while it sits here.
  marketplace          TEXT,
  marketplace_agent_id TEXT,
  marketplace_buyer_id TEXT,
  task_ref             TEXT,
  service_order_ref    TEXT,

  -- Where to send the browser back to. Validated against an allowlist at creation, because an
  -- attacker-chosen return URL turns a link flow into an open redirect with a session at the end of it.
  return_url           TEXT,

  -- PENDING | COMPLETED | EXPIRED | CANCELLED. There is no state meaning "probably redeemed".
  status               TEXT        NOT NULL DEFAULT 'PENDING',

  expires_at           TIMESTAMPTZ NOT NULL,
  consumed_at          TIMESTAMPTZ,
  -- How many redemption attempts this request has seen. A code that can be guessed at without limit is
  -- a code whose length is the only defence; this makes the attempts countable and therefore boundable.
  attempts             INTEGER     NOT NULL DEFAULT 0,

  source_request_id    TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           TEXT        NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT        NOT NULL,

  CONSTRAINT untch_link_status_known CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  -- A completed request must name the account it produced and the moment it was consumed. Without both,
  -- "this code was used" is a claim with no subject and no time.
  CONSTRAINT untch_link_completed_resolved
    CHECK (status <> 'COMPLETED' OR (account_id IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS untch_link_requests_pending
  ON untch_account_link_requests (status, expires_at);
CREATE INDEX IF NOT EXISTS untch_link_requests_by_agent
  ON untch_account_link_requests (marketplace, marketplace_agent_id)
  WHERE marketplace_agent_id IS NOT NULL;
-- One SIWE nonce belongs to one link request. Two requests sharing a nonce would let a signature
-- produced for one be redeemed against the other.
CREATE UNIQUE INDEX IF NOT EXISTS untch_link_requests_nonce_unique
  ON untch_account_link_requests (siwe_nonce);

-- ─────────────────────────────────────────────────────────────────────────────
-- Channel bindings — where an approval may be delivered, and who may answer it
-- ─────────────────────────────────────────────────────────────────────────────

-- A Telegram chat, a Discord user, an email address. Each is a place Untch may SEND an approval request
-- and, for the interactive ones, a place a decision may come back from.
--
-- THE DISTINCTION THAT MATTERS
--
-- `can_decide` is separate from the row's existence. An email binding can receive an approval request
-- and can never answer one — the answer arrives through an authenticated web session, because an email
-- address is a delivery destination and a sender address is trivially forged. Telegram and Discord can
-- answer, because the callback carries a platform-verified user identity that this row was bound to.
-- Storing that as a column rather than inferring it from the channel name means the email adapter
-- cannot acquire decision authority by someone later adding a reply parser.
CREATE TABLE IF NOT EXISTS untch_channel_bindings (
  binding_id      TEXT PRIMARY KEY,
  account_id      TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,

  -- 'telegram' | 'discord' | 'email' | 'dashboard'.
  channel         TEXT        NOT NULL,

  -- The platform's own identity for this user. A Telegram user id, a Discord user id, an email address.
  -- This is what an inbound callback is compared against, so a forwarded button press from a different
  -- account's chat fails the comparison rather than the routing.
  channel_user_id TEXT        NOT NULL,
  -- Where to deliver. A Telegram chat id, a Discord channel id. May equal `channel_user_id` for a DM.
  channel_chat_id TEXT,
  display_label   TEXT,

  -- Whether a decision may ARRIVE from this channel. False for email, by design and not by omission.
  can_decide      BOOLEAN     NOT NULL DEFAULT false,

  status          TEXT        NOT NULL DEFAULT 'ACTIVE',
  verified_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT        NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT        NOT NULL,

  CONSTRAINT untch_channel_known CHECK (channel IN ('telegram', 'discord', 'email', 'dashboard')),
  CONSTRAINT untch_channel_status_known CHECK (status IN ('ACTIVE', 'REVOKED')),
  -- A channel that may decide must have been verified. An unverified decider is a channel where the
  -- binding step was skipped and the authority was granted anyway.
  CONSTRAINT untch_channel_decider_verified CHECK (can_decide = false OR verified_at IS NOT NULL)
);

-- One platform identity decides for at most one account at a time. Without this, two accounts could
-- both bind the same Telegram user and an inbound callback would have two possible owners.
CREATE UNIQUE INDEX IF NOT EXISTS untch_channel_one_active_identity
  ON untch_channel_bindings (channel, channel_user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS untch_channel_by_account ON untch_channel_bindings (account_id, status);

-- The one-time code that binds a channel. Separate from the account link request because the two grant
-- different things: an account link establishes WHO an account is, a channel bind establishes WHERE it
-- can be reached. Sharing a table would mean one code could be redeemed for either.
CREATE TABLE IF NOT EXISTS untch_channel_bind_codes (
  code_id      TEXT PRIMARY KEY,
  account_id   TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,
  channel      TEXT        NOT NULL,
  code_hash    TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'PENDING',
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT        NOT NULL,

  CONSTRAINT untch_channel_code_status_known CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT untch_channel_code_channel_known CHECK (channel IN ('telegram', 'discord', 'email'))
);

CREATE INDEX IF NOT EXISTS untch_channel_bind_codes_open
  ON untch_channel_bind_codes (status, expires_at);
