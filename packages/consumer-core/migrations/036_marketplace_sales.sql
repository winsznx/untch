-- Every settled marketplace sale, recorded because four of them were not.
--
-- WHAT WENT WRONG
--
-- An independent buyer paid for four standalone tools. All four settled on X Layer, the seller balance
-- moved by exactly the sum of the fees, and this database recorded nothing at all. The existing
-- `untch_x402_service_calls` table is the wrong home for them: its `account_id` is NOT NULL and
-- references `untch_accounts`, because it was built for the governed pipeline where a call belongs to
-- somebody's policy. A stranger buying `suggest_names` has no account here and should not need one.
--
-- WHY NOT AUTO-CREATE AN ACCOUNT INSTEAD
--
-- Because an x402 authorization is a payment signature, not an identity assertion. This codebase draws
-- that line deliberately elsewhere — `carriesAuthority` on a marketplace binding exists precisely to
-- say that a binding proven by something other than a wallet signature authorises nothing. Minting an
-- account from a payment would erase that distinction at exactly the point where money is involved.
--
-- A sale is a fact about a transfer. It is not a claim about who someone is.
--
-- WHAT THIS IS FOR
--
-- Reconciliation and receipts. A seller must be able to answer "what did I sell, to whom, for how
-- much, and where is the transaction" without reading a block explorer, and a buyer must be able to
-- prove a purchase. Neither was possible before this table.

CREATE TABLE IF NOT EXISTS untch_marketplace_sales (
  sale_id             TEXT PRIMARY KEY,

  -- What was bought. `route` is the path as mounted; `tool_id` is the registry's stable identifier,
  -- kept alongside it so a future route rename does not orphan the sales history.
  route               TEXT        NOT NULL,
  tool_id             TEXT,

  -- Who paid, and on what rail. Lowercased on write so a checksummed and an unchecksummed address
  -- from two different clients do not read as two different buyers.
  payer               TEXT        NOT NULL,
  pay_to              TEXT        NOT NULL,
  token               TEXT        NOT NULL,
  network             TEXT        NOT NULL,

  -- Base units, as a string. The amounts are exact integers and a float would round them.
  amount_base_units   TEXT        NOT NULL,

  -- The settlement itself. `transaction_hash` is nullable because the facilitator may confirm a
  -- settlement before the hash is observable, and a row with no hash is still a real sale.
  transaction_hash    TEXT,
  facilitator_status  TEXT,

  -- What the buyer actually received. A sale that returned a 200 and a sale that returned a 200 with
  -- an empty body are different outcomes, and only one of them is worth defending in a dispute.
  response_status     INTEGER     NOT NULL,
  response_bytes      INTEGER,

  -- The authorization nonce, which is what makes a replay visible. Two sales quoting the same nonce
  -- are the same authorization presented twice.
  authorization_nonce TEXT,

  settled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One settlement per authorization nonce. The facilitator deduplicates too, but a seller that cannot
-- see a replay in its own records cannot answer a question about one.
CREATE UNIQUE INDEX IF NOT EXISTS untch_marketplace_sales_nonce
  ON untch_marketplace_sales (authorization_nonce)
  WHERE authorization_nonce IS NOT NULL;

-- The two questions asked of this table: what did this buyer purchase, and what did this tool earn.
CREATE INDEX IF NOT EXISTS untch_marketplace_sales_payer
  ON untch_marketplace_sales (payer, settled_at DESC);

CREATE INDEX IF NOT EXISTS untch_marketplace_sales_tool
  ON untch_marketplace_sales (tool_id, settled_at DESC);
