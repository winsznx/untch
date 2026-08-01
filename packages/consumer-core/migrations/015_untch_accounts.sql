-- An account that a wallet owns, replacing a tenancy that was a policy partition.
--
-- WHAT WAS THERE BEFORE
--
-- A tenant WAS a policy: `policy:<policyId>`. That is namespacing, and for a while it was enough,
-- because a policy has an on-chain owner and a session is only minted to that owner. But it makes two
-- things impossible to express, and both of them are in the way of the product's own journey:
--
--   • one person with two policies is TWO disjoint worlds. There is no query that spans them, no
--     dashboard that shows both, and no "my policies" — because there is no "my".
--   • a marketplace identity has nowhere to live. `untch:agent:<id>` was recorded on a session for
--     audit and authorised nothing, so a job created on OKX and a policy held in Untch could never be
--     reconciled to the same person even when they were.
--
-- WHAT REPLACES IT
--
-- An account, whose authority is a VERIFIED WALLET and nothing else. Everything a person accumulates —
-- policies, a second wallet on another chain, a marketplace identity, the jobs that identity took on —
-- hangs off that account, and each of those is a BINDING with its own proof and its own provenance.
--
-- WHY THE PRIMARY KEY IS OPAQUE
--
-- Not an email, and not an address. Not an email because an email authenticates a login provider and
-- never authorises spending here — making it the key would make a mailbox the thing that owns money.
-- Not an address either, though that is the tempting one: an account may bind a second wallet, may
-- rotate a compromised one, and must survive both without every foreign key in the schema changing
-- meaning. The key is an opaque id; the address is a binding, and bindings are rows.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No password column, no key material, no OAuth token. Social login belongs to OKX and Untch never
-- sees it; a mailbox grant is a capability a provider holds, never an authority here. A column that
-- could hold a private key is a column that will eventually hold one.
--
-- NOTHING EXISTING IS REWRITTEN
--
-- No policy, intent or receipt row is touched by this migration. The policy-partition tenant remains
-- exactly what it was, and remains the thing every existing row is keyed by. `untch_account_policies`
-- is an ADDITIONAL index from a policy to an account, so the account view is a join rather than a
-- rewrite — and a policy with no account row behaves precisely as it does today. Public receipts are
-- unaffected: they are built by naming publishable fields on an intent, and no field changes here.

-- ─────────────────────────────────────────────────────────────────────────────
-- The account
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_accounts (
  -- `acct_` + 26 lowercase base32 characters. Opaque on purpose: it carries no email, no address and
  -- no ordering, so it cannot be guessed from something public or enumerated by counting up.
  account_id          TEXT PRIMARY KEY,

  -- ACTIVE | SUSPENDED | CLOSED. SUSPENDED still reads; it does not spend. CLOSED is terminal and
  -- keeps its rows, because a receipt that becomes unreadable when an account closes is not a receipt.
  status              TEXT        NOT NULL DEFAULT 'ACTIVE',

  -- What a human calls this account. Never an identifier, never unique, never used to resolve anything.
  display_name        TEXT,

  -- The policy a request may name with `useDefaultPolicy`. NULL means the account has not chosen one,
  -- and a request that asked for the default is then refused rather than silently given a policy
  -- whose limits nobody picked.
  default_policy_id   TEXT,

  -- The last policy this account actually used. Distinct from the default: one is a CHOICE and the
  -- other is a FACT, and conflating them would make an experiment silently become a default.
  last_used_policy_id TEXT,

  -- Provenance, on every row in this migration. `created_by` records HOW the row came to exist —
  -- 'siwe' for a proven sign-in, 'backfill:policy-partition' for a legacy policy adopted into an
  -- account, 'operator' for an operator action. When an account's authority is later questioned, the
  -- answer has to be readable rather than inferred from timestamps.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT        NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT        NOT NULL,

  CONSTRAINT untch_accounts_status_known CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CONSTRAINT untch_accounts_id_shape CHECK (account_id ~ '^acct_[a-z0-9]{26}$')
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Wallet bindings — the only thing that carries authority
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_wallet_bindings (
  account_id  TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,

  -- 'evm' | 'solana'. Kept as a kind rather than a chain id because a key is the same key on every
  -- EVM chain, and a binding that had to be repeated per chain would invite one of them to disagree.
  chain_kind  TEXT        NOT NULL,

  -- Lowercase hex for EVM, base58 for Solana. Normalisation happens in the writer, and the CHECK below
  -- enforces it, because two spellings of one address is two identities as far as a unique index cares.
  address     TEXT        NOT NULL,

  -- 'primary' — the account's authority. 'settlement' — a wallet funds move through, which proves
  -- nothing about who may authorise them. Separated because collapsing them is how a treasury key ends
  -- up able to sign for an account.
  role        TEXT        NOT NULL,

  -- 'siwe' is the only value that means anything today. 'declared' exists so an address can be
  -- RECORDED without pretending it was proven — a Solana address noted by an operator is not a proof,
  -- and a schema with nowhere to say that would have it stored as though it were.
  proof_kind  TEXT        NOT NULL,

  -- A reference to the proof — the consumed nonce. NEVER the signature material, and never a key.
  proof_ref   TEXT,
  verified_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT        NOT NULL,

  -- One address belongs to at most one account. Enforced here rather than in code because the check
  -- that matters is the one two concurrent sign-ins cannot both pass.
  PRIMARY KEY (chain_kind, address),

  CONSTRAINT untch_wallet_chain_kind_known CHECK (chain_kind IN ('evm', 'solana')),
  CONSTRAINT untch_wallet_role_known CHECK (role IN ('primary', 'settlement')),
  CONSTRAINT untch_wallet_proof_known CHECK (proof_kind IN ('siwe', 'declared')),
  CONSTRAINT untch_wallet_evm_lowercase CHECK (chain_kind <> 'evm' OR address ~ '^0x[0-9a-f]{40}$'),
  -- A binding that claims to be proven must say when. A verified_at that is NULL beside proof_kind
  -- 'siwe' would be a proof nobody can date.
  CONSTRAINT untch_wallet_proof_dated CHECK (proof_kind <> 'siwe' OR verified_at IS NOT NULL)
);

-- Exactly one primary EVM wallet per account. The account's authority is singular by construction:
-- two primaries would mean two answers to "who owns this", resolved by whichever query ran.
CREATE UNIQUE INDEX IF NOT EXISTS untch_wallet_one_primary_evm
  ON untch_wallet_bindings (account_id)
  WHERE chain_kind = 'evm' AND role = 'primary';

-- At most one Solana wallet per account. Optional, singular when present.
CREATE UNIQUE INDEX IF NOT EXISTS untch_wallet_one_solana
  ON untch_wallet_bindings (account_id)
  WHERE chain_kind = 'solana';

CREATE INDEX IF NOT EXISTS untch_wallet_by_account ON untch_wallet_bindings (account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Marketplace bindings — audit context until a wallet proves them
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS untch_marketplace_bindings (
  account_id   TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,

  -- 'okx' today. Named rather than assumed, because a second marketplace would otherwise silently
  -- share an agent id namespace with the first.
  marketplace  TEXT        NOT NULL,

  -- The agent identity on that marketplace (ERC-8004 id for OKX).
  agent_id     TEXT        NOT NULL,

  -- The buyer identity, where the marketplace distinguishes it from the agent.
  buyer_id     TEXT,

  -- 'unproven' | 'wallet-signature'.
  --
  -- This is the field that decides whether the binding may AUTHORISE anything, and 'unproven' is the
  -- honest default. An agent id arriving in a request header is a claim; it becomes authority only
  -- when the account's own wallet has signed for it. Until then the binding is audit context — which
  -- is exactly what it already was, now with somewhere to say so.
  proven_by    TEXT        NOT NULL DEFAULT 'unproven',
  proof_ref    TEXT,
  verified_at  TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT        NOT NULL,

  PRIMARY KEY (marketplace, agent_id),

  CONSTRAINT untch_marketplace_proven_known CHECK (proven_by IN ('unproven', 'wallet-signature')),
  CONSTRAINT untch_marketplace_proof_dated CHECK (proven_by = 'unproven' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS untch_marketplace_by_account ON untch_marketplace_bindings (account_id);

-- The jobs a marketplace identity took on. Recorded so a job on OKX and an intent in Untch can be
-- reconciled to one account, which today they cannot be at all.
CREATE TABLE IF NOT EXISTS untch_marketplace_jobs (
  marketplace TEXT        NOT NULL,
  job_id      TEXT        NOT NULL,
  account_id  TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,
  agent_id    TEXT,
  -- The Untch intent this job produced, when one exists. NULL is normal and means the job has not
  -- reached an intent yet — not that it never will.
  intent_id   TEXT,
  status      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT        NOT NULL,

  PRIMARY KEY (marketplace, job_id)
);

CREATE INDEX IF NOT EXISTS untch_marketplace_jobs_by_account ON untch_marketplace_jobs (account_id);
CREATE INDEX IF NOT EXISTS untch_marketplace_jobs_by_intent ON untch_marketplace_jobs (intent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Policies, indexed onto accounts WITHOUT touching the policies table
-- ─────────────────────────────────────────────────────────────────────────────

-- The join that turns "a tenant is a policy" into "an account has policies".
--
-- A separate table rather than a column on `policies`, and the reason is the migration path. The
-- policies table is written by the policy store and read by preflight on every decision; adding a
-- nullable account column would work, and would also mean every existing row silently acquires a NULL
-- account that some later query has to decide the meaning of. A join table has no such ambiguity: a
-- policy is in an account or it is not, and a policy that is not behaves exactly as it does today.
CREATE TABLE IF NOT EXISTS untch_account_policies (
  account_id  TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,
  -- The on-chain policy id, as text. Deliberately NOT a foreign key onto `policies`: that table lives
  -- in a different package's migration set and may not have been applied to this database, and a
  -- foreign key across that boundary would make this migration fail for a reason that has nothing to
  -- do with accounts.
  policy_id   TEXT        NOT NULL,
  -- How the policy came to be in this account. 'registered' — created through the account. 'adopted'
  -- — an existing policy claimed by the account that owns its on-chain owner address.
  linked_by   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT        NOT NULL,

  PRIMARY KEY (policy_id),

  CONSTRAINT untch_account_policies_linked_known CHECK (linked_by IN ('registered', 'adopted'))
);

CREATE INDEX IF NOT EXISTS untch_account_policies_by_account ON untch_account_policies (account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Policy drafts — a policy before it exists on chain
-- ─────────────────────────────────────────────────────────────────────────────

-- The predecessor the two rejected services need, up to the point where a transaction is required.
--
-- A draft is what a user has decided their rules should be, held server-side, hashed the same way the
-- registry will hash them. It is NOT a policy: nothing evaluates against a draft, and a draft has no
-- id the chain would recognise. Registration is a transaction the USER's wallet sends — the owner of a
-- policy must be the person it governs, and a server-owned policy would make Untch the owner of every
-- user's spending rules.
CREATE TABLE IF NOT EXISTS untch_policy_drafts (
  draft_id     TEXT PRIMARY KEY,
  account_id   TEXT        NOT NULL REFERENCES untch_accounts(account_id) ON DELETE CASCADE,

  -- The rules, canonicalised. `policy_hash` is computed the same way the registry computes it, so a
  -- draft and its eventual on-chain policy can be compared byte for byte rather than by eye.
  rules        JSONB       NOT NULL,
  policy_hash  TEXT        NOT NULL,

  -- The agent this policy will govern. Immutable on chain after registration, so it is fixed here too.
  agent_id     TEXT        NOT NULL,

  -- DRAFT — being edited. SUBMITTED — a transaction has been sent and not yet confirmed. CONFIRMED —
  -- the registration event was read and `policy_id` is real. ABANDONED — the user walked away.
  --
  -- There is no state meaning "probably registered". A draft is CONFIRMED only when a PolicyRegistered
  -- event has actually been read, because the alternative is a row that claims a policy exists and a
  -- chain that disagrees.
  status       TEXT        NOT NULL DEFAULT 'DRAFT',

  chain_id     BIGINT      NOT NULL,
  -- Set when SUBMITTED. The transaction the user's own wallet sent.
  register_tx  TEXT,
  -- Set when CONFIRMED, read from the event rather than assumed from the sender.
  policy_id    TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT        NOT NULL,

  CONSTRAINT untch_policy_drafts_status_known
    CHECK (status IN ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'ABANDONED')),
  -- A confirmed draft without a policy id is a claim with nothing behind it.
  CONSTRAINT untch_policy_drafts_confirmed_has_policy
    CHECK (status <> 'CONFIRMED' OR (policy_id IS NOT NULL AND register_tx IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS untch_policy_drafts_by_account ON untch_policy_drafts (account_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS untch_policy_drafts_one_per_policy
  ON untch_policy_drafts (policy_id)
  WHERE policy_id IS NOT NULL;
