-- One EVM wallet address belongs to one UntchAccount for its lifetime.
--
-- WHY THIS IS LOAD-BEARING, AND NOT MERELY TIDY
--
-- The deployed EIP-712 `SpendIntent` has eleven fields and none of them names an account. For a direct
-- Untch-account request the only field that can identify a requester is `owner`, which is set to the
-- policy's on-chain owner address. That address identifies an ACCOUNT only because an address belongs
-- to exactly one account — so this invariant is the last link in the chain that makes a direct request
-- attributable at all, and `buyerAgentId = 0` admissible.
--
-- If an address could move between accounts, then a receipt anchored under `owner = 0xA…` would name
-- whichever account happened to hold 0xA… at the time, and the same intent hash would describe two
-- different payers at two different moments. Nothing on chain would show the difference.
--
-- WHAT WAS ALREADY TRUE, AND WHAT WAS NOT
--
-- Migration 015 already made the mapping permanent with PRIMARY KEY (chain_kind, address), and
-- `linkWallet` already refuses to move an address between accounts via
-- `WHERE untch_wallet_bindings.account_id = EXCLUDED.account_id`. Two things were missing:
--
--   • nothing stopped an UPDATE from rewriting `account_id` directly — a repair script, a console
--     session or a later migration could have moved an address with one statement;
--   • nothing stopped a DELETE from removing the row, which WOULD free the address, because the
--     uniqueness that protects the invariant is the presence of the row.
--
-- Both are closed here, at the table, because the property has to survive people who have not read
-- this comment.
--
-- WHAT THIS IS NOT
--
-- It is not account recovery. Moving a wallet to a different account is a real need with a real
-- answer — an explicit, audited recovery or merge protocol with a human in it — and the answer is not
-- "issue an UPDATE". A recovery protocol that exists will have to lift these triggers deliberately,
-- in its own migration, which is exactly the amount of friction the operation deserves.

CREATE OR REPLACE FUNCTION untch_wallet_binding_account_is_permanent() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'untch_wallet_bindings rows are permanent: deleting binding % for account % would '
      'FREE address % to be claimed by a different account, and every direct decision ever receipted '
      'under that address would become unattributable. Revoke it instead — revocation ends authority '
      'and keeps the proof.',
      OLD.binding_id, OLD.account_id, OLD.address;
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'wallet address % is permanently bound to account %, and cannot be moved to %. '
      'A direct request is identified on chain only by this address, so moving it would silently '
      'reassign past decisions. Account recovery is a separate audited protocol, not an UPDATE.',
      OLD.address, OLD.account_id, NEW.account_id;
  END IF;

  IF NEW.address IS DISTINCT FROM OLD.address OR NEW.chain_kind IS DISTINCT FROM OLD.chain_kind THEN
    RAISE EXCEPTION 'the address of binding % cannot be rewritten: the row IS the claim on % and '
      'editing it would release that address while keeping the history that refers to it.',
      OLD.binding_id, OLD.address;
  END IF;

  -- `verified_at` is the date of a proof that happened. Re-proving writes a new verified_at forward in
  -- time; nothing may erase it, because a revoked binding's original proof is what a dispute reads.
  IF OLD.verified_at IS NOT NULL AND NEW.verified_at IS NULL THEN
    RAISE EXCEPTION 'binding % was proven at %, and that cannot be unset. Ending authority is '
      'revocation, not the deletion of the evidence it existed.', OLD.binding_id, OLD.verified_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS untch_wallet_binding_permanence ON untch_wallet_bindings;
CREATE TRIGGER untch_wallet_binding_permanence
  BEFORE UPDATE OR DELETE ON untch_wallet_bindings
  FOR EACH ROW EXECUTE FUNCTION untch_wallet_binding_account_is_permanent();

COMMENT ON TABLE untch_wallet_bindings IS
  'One address belongs to one account for its lifetime, enforced by PRIMARY KEY (chain_kind, address) and by the permanence trigger. Revocation ends authority and keeps the row; the address is never freed. Moving an address to another account requires an explicit audited recovery protocol, which does not exist yet. This invariant is load-bearing: the legacy SpendIntent commits the policy owner ADDRESS and no accountRefHash, so address-to-account permanence is what makes a direct account decision attributable.';

COMMENT ON COLUMN untch_wallet_bindings.status IS
  'ACTIVE | REVOKED. REVOKED disables authority and does NOT free the address. Re-linking the same address later resolves the SAME account, never a different one.';
