-- Public settlement-account registration, separated from signer availability.
--
-- WHAT WAS WRONG
--
-- `consumer_treasury_accounts` rows were only ever written from a rail client's `address()`, which
-- throws without a private key. Registering an account therefore REQUIRED the key to be loaded, so an
-- unarmed deployment could not record that a float existed, and a preflight against it reported
-- SETTLEMENT_TREASURY_ABSENT for a wallet that was funded and waiting. "The account is registered" and
-- "this process can spend from it" were one fact when they are four:
--
--   registered   →  a public authority is recorded, with on-chain evidence
--   funded       →  the observed balance clears the floor
--   signer       →  a key is present in this process
--   executable   →  the rail's switch is thrown and the signer matches the registered authority
--
-- WHAT THIS ADDS
--
-- The evidence needed to hold the first two without the last two. `attestation` carries what was read
-- from the chain at registration: the derived token account, its program, its owner, the mint and
-- decimals taken from the registry rather than from the caller, the observed balances, and the three
-- fields that decide whether a balance is really ours to spend — account state, delegate, and close
-- authority. A frozen account, a delegated account or one with a live close authority is refused.
--
-- Nullable, and null is not benign. Every reader treats an absent attestation as unattested and
-- refuses, so the two rows that predate this migration (the Base settlement float, which is registered
-- from a key that is genuinely present, and the X Layer funding row) keep working exactly as before
-- without being silently promoted to "verified clean".

ALTER TABLE consumer_treasury_accounts
  ADD COLUMN IF NOT EXISTS attestation          JSONB,
  ADD COLUMN IF NOT EXISTS registration_version INTEGER;

-- The public authority is the identity a later-loaded signer is checked against, so it has to be
-- queryable on its own rather than only reachable by parsing the JSONB.
CREATE INDEX IF NOT EXISTS consumer_treasury_accounts_authority
  ON consumer_treasury_accounts ((attestation ->> 'authority'))
  WHERE attestation IS NOT NULL;
