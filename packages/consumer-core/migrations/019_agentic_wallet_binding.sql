-- The wallet Untch was always about, told apart from the one a browser happens to inject.
--
-- WHAT WAS WRONG
--
-- 015 through 018 modelled one kind of wallet binding: an EVM address that proved itself with SIWE.
-- That is true of both wallets a user might hold and it hides the distinction that matters most here.
--
-- The PRIMARY identity for Untch is the OKX Onchain OS Agentic Wallet: created or restored through
-- email, Google or Apple login, held inside OKX's TEE, and reached through the `onchainos` CLI or
-- skill. It is not injected into a browser. There is no `window.ethereum` for it, and a sign-in flow
-- built on an EIP-1193 provider cannot reach it at all — it reaches the OKX browser EXTENSION, which
-- is a different wallet product with different keys and a different recovery story.
--
-- Both can sign. Only one is the wallet a user's Onchain OS agent already spends from, and a schema
-- that calls them the same thing will eventually let a browser extension become the owner of policies
-- the agent cannot use.
--
-- WHY A KIND COLUMN RATHER THAN A SECOND TABLE
--
-- Every property the two share is load-bearing and identical: an account, an address, a scope set, a
-- revocation, a proof reference. Splitting the table would duplicate the partial unique index that
-- makes "one active binding per address" true, and two copies of that rule is one copy that drifts.
-- So the row stays, and `binding_kind` says which product proved it.
--
-- WHY THE AGENTIC METADATA IS NULLABLE AND SEPARATE
--
-- A browser binding has no Onchain OS account id, no sub-wallet selection and no CLI version. Forcing
-- those onto every row would mean inventing values for the rows that do not have them, which is how a
-- NULL that means "not applicable" turns into a zero that means "unknown".
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No email. No OTP. No login session. No API secret. No mnemonic, key or reusable credential of any
-- kind. Email AUTHENTICATES access to the Agentic Wallet at OKX; it is not spending authority here and
-- Untch has nowhere to put it. What proves authority is a signature from the wallet, and the only
-- thing stored about it is the consumed nonce it was produced over.

-- ─────────────────────────────────────────────────────────────────────────────
-- Which wallet product proved this binding
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE untch_wallet_bindings
  -- 'agentic'  — OKX Onchain OS Agentic Wallet, TEE-held, reached through the onchainos CLI or skill.
  -- 'browser'  — an injected EIP-1193 provider: the OKX extension, or any other browser wallet.
  -- 'declared' — recorded by an operator and never proven. Present so a note cannot pass for a proof.
  --
  -- Defaulted to 'browser' rather than 'agentic', because every row written before this migration came
  -- through the browser SIWE path and calling them agentic would be backdating a claim. There are zero
  -- such rows in production today, so the default is a statement about the code that wrote them rather
  -- than about any data.
  ADD COLUMN IF NOT EXISTS binding_kind TEXT NOT NULL DEFAULT 'browser',

  -- The Onchain OS account this wallet belongs to, when the agent reported one. Opaque and internal:
  -- it identifies a wallet grouping at OKX and is never shown to a user, per the wallet skill's own
  -- rule that the account NAME is displayable and the id is not.
  ADD COLUMN IF NOT EXISTS agentic_account_ref TEXT,

  -- Which sub-wallet the user CHOSE, when their Onchain OS login holds more than one. Recorded because
  -- picking one silently is the failure this column exists to make visible: a user with three wallets
  -- who is never asked ends up with policies owned by whichever one sorted first.
  ADD COLUMN IF NOT EXISTS agentic_selected_wallet TEXT,

  -- 'email' | 'google' | 'apple' — how the user reached their Agentic Wallet. Audit context only. It
  -- is NOT authority: an email proves access to a login provider and never proves control of a key.
  ADD COLUMN IF NOT EXISTS agentic_auth_method TEXT,

  -- The Solana address of the same Agentic Wallet, when the agent reported one. One login holds both,
  -- and recording the pair here is what lets a Solana settlement later be attributed to this account
  -- without a second binding that could disagree about who owns it.
  ADD COLUMN IF NOT EXISTS agentic_solana_address TEXT,

  -- The onchainos CLI or skill version that produced the signature. A signature is only as
  -- interpretable as the tool that made it, and a future change in message handling has to be
  -- attributable to a version rather than to a guess.
  ADD COLUMN IF NOT EXISTS agentic_tool_version TEXT,

  -- The link request this binding came from. Ties a binding to the exact server-authored challenge,
  -- so "which nonce, issued when, for which scopes" is answerable from the row rather than from logs.
  ADD COLUMN IF NOT EXISTS challenge_ref TEXT,

  -- How the challenge reached the wallet: 'agent-cli' | 'browser-provider' | 'operator'. Distinct from
  -- proof_kind, which says what KIND of proof it is. Two bindings can both be SIWE and have arrived
  -- through completely different trust paths.
  ADD COLUMN IF NOT EXISTS challenge_transport TEXT;

ALTER TABLE untch_wallet_bindings
  DROP CONSTRAINT IF EXISTS untch_wallet_binding_kind_known;
ALTER TABLE untch_wallet_bindings
  ADD CONSTRAINT untch_wallet_binding_kind_known
    CHECK (binding_kind IN ('agentic', 'browser', 'declared'));

-- A browser binding must not carry Agentic Wallet metadata. Enforced rather than trusted, because the
-- whole point of the split is that a browser wallet cannot present itself as the agentic one.
ALTER TABLE untch_wallet_bindings
  DROP CONSTRAINT IF EXISTS untch_wallet_agentic_fields_only_when_agentic;
ALTER TABLE untch_wallet_bindings
  ADD CONSTRAINT untch_wallet_agentic_fields_only_when_agentic
    CHECK (
      binding_kind = 'agentic'
      OR (agentic_account_ref IS NULL
          AND agentic_selected_wallet IS NULL
          AND agentic_auth_method IS NULL
          AND agentic_solana_address IS NULL)
    );

CREATE INDEX IF NOT EXISTS untch_wallet_bindings_kind
  ON untch_wallet_bindings (account_id, binding_kind)
  WHERE status = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────────────────────
-- The link request, taught to describe a wallet it cannot see
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A browser link request is completed by the same browser that started it. An agentic link request is
-- started in a browser and completed by an AGENT, possibly on another machine, minutes later. The
-- browser therefore has to poll, and polling needs a state that is meaningful before a signature
-- exists.

ALTER TABLE untch_account_link_requests
  -- 'browser' | 'agentic'. Decides which routes may complete it. An agentic request completed through
  -- the browser path, or the reverse, is refused rather than silently accepted.
  ADD COLUMN IF NOT EXISTS link_kind TEXT NOT NULL DEFAULT 'browser',

  -- WAITING_FOR_AGENT — created, nobody has fetched the challenge yet.
  -- WAITING_FOR_SIGNATURE — an agent has read the challenge and is presenting it to the user.
  -- The terminal states are the request's own `status`; this column is the finer-grained progress a
  -- polling page needs in order to say something true while nothing has happened yet.
  ADD COLUMN IF NOT EXISTS agent_stage TEXT,

  -- When the challenge was first read. Distinguishes "the agent never picked this up" from "the agent
  -- picked it up and the user has not signed", which are different problems with different advice.
  ADD COLUMN IF NOT EXISTS challenge_fetched_at TIMESTAMPTZ,

  -- The address the agent reported it will sign with, recorded when the challenge is fetched. Lets the
  -- browser show the expected address BEFORE the signature exists, and lets completion refuse a
  -- signature from a different wallet than the one the user was shown.
  ADD COLUMN IF NOT EXISTS expected_address TEXT;

ALTER TABLE untch_account_link_requests
  DROP CONSTRAINT IF EXISTS untch_link_kind_known;
ALTER TABLE untch_account_link_requests
  ADD CONSTRAINT untch_link_kind_known
    CHECK (link_kind IN ('browser', 'agentic'));
