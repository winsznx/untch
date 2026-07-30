-- Delivery verifications, recorded as immutable rows rather than as edits to a receipt.
--
-- WHY A NEW TABLE AND NOT A COLUMN UPDATE
--
-- The first bounded Purch proof settled 0.010000 USDC, returned five real products, and produced a
-- receipt saying `untchVerified: false, method: NONE`. That was accurate at the time: the adapter's
-- delivery check was written for a physical shipment, where Untch can prove an order was placed and
-- cannot prove a parcel arrived. For a paid READ the returned result IS the delivered service, so the
-- same reasoning gives the wrong answer — and the check was never made shape-aware.
--
-- The fix is to verify it now. But a receipt is a historical claim, and quietly flipping
-- `untchVerified` to true on a row dated at settlement time would assert that Untch checked something
-- at a moment when it had not. That is the kind of edit nobody can later audit: the receipt would look
-- exactly as though verification had always been there.
--
-- So a verification is its own row, with its own timestamp, its own verifier version and the hashes of
-- every input it read. The original receipt keeps its original fields and its original times; the
-- public view shows the later verification ALONGSIDE it, dated, with its relationship stated. A reader
-- can see both what was known at settlement and what was established afterwards.
--
-- IDEMPOTENT BY CONSTRUCTION
--
-- The primary key is (intent_id, verifier_version, evidence_digest). Re-running a redrive over
-- unchanged evidence collides with the row it already wrote and changes nothing, so a repeated
-- operation cannot produce a second, conflicting claim about the same facts. A genuinely different
-- input — different evidence, or a newer verifier — writes a new row and leaves the old one intact,
-- which is what makes the history readable rather than overwritten.

CREATE TABLE IF NOT EXISTS consumer_delivery_verifications (
  intent_id         TEXT NOT NULL,
  -- Bumped when the checks change. Two versions may disagree, and both records survive so the
  -- disagreement is visible instead of resolved by whichever ran last.
  verifier_version  TEXT NOT NULL,
  -- A hash over every persisted input the verifier read. Identical inputs ⇒ identical digest ⇒ the
  -- same row, which is what makes the redrive idempotent without a separate lock.
  evidence_digest   TEXT NOT NULL,

  verification_id   TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  capability        TEXT NOT NULL,
  execution_shape   TEXT NOT NULL,
  method            TEXT NOT NULL,
  verified          BOOLEAN NOT NULL,
  detail            TEXT NOT NULL,

  -- The individual input hashes, so a dispute can see WHICH artefact was read rather than only that
  -- some bundle of them hashed to a value.
  request_hash      TEXT,
  result_hash       TEXT,
  quote_hash        TEXT,
  settlement_tx     TEXT,
  settled_amount    TEXT,
  settlement_chain  TEXT,

  -- The receipt this verification refers to, and the superseding receipt it produced where one exists.
  -- Both nullable: a verification can be recorded before a receipt is revised, and the original may be
  -- absent on an intent that never reached one.
  original_receipt_id     TEXT,
  superseding_receipt_id  TEXT,

  -- Every refusal reason, when `verified` is false. A failed verification is evidence too, and deleting
  -- it would leave no record that the question was asked.
  refusals          JSONB NOT NULL DEFAULT '[]'::jsonb,

  verified_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (intent_id, verifier_version, evidence_digest)
);

-- The newest verification for an intent, which is what a projection reads.
CREATE INDEX IF NOT EXISTS consumer_delivery_verifications_intent
  ON consumer_delivery_verifications (intent_id, verified_at DESC);
