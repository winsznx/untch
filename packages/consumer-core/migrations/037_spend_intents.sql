-- Spend intents, made durable because a Worker has no memory between requests.
--
-- WHY THIS IS NEEDED NOW AND WAS NOT BEFORE
--
-- `create_spend_intent` stores an intent, and `preflight_payment` and `verify_delivery` look it up by
-- hash on a LATER request. On Railway that worked because one long-lived process held an in-memory map
-- across both calls. A Cloudflare Worker has no such continuity: the second request may land in a
-- different isolate, in a different colo, with an empty map — so the pipeline would fail intermittently
-- and for a reason no error message would explain.
--
-- An independent buyer hit exactly this from the other side: `create_spend_intent` was not ported at
-- all, and the two paid services that depend on it could not complete. Porting it against an in-memory
-- store would have replaced a clean 503 with an intermittent "intent not found", which is worse — a
-- caller can retry a 503 and cannot debug a coin flip.
--
-- WHY JSONB
--
-- The intent is echoed back to the caller and re-hashed on lookup; nothing here queries inside it. A
-- column-per-field model would have to track every future change to the intent shape, and a mismatch
-- between the stored columns and the canonical struct is exactly how a hash stops matching.
--
-- WHY IT EXPIRES
--
-- An intent is a short-lived quote, not a record. The in-memory store bounded itself at 1000 entries
-- and dropped the oldest; this bounds by TIME instead, which is the property that actually matters —
-- an intent nobody spent within the window should not be spendable later.

CREATE TABLE IF NOT EXISTS untch_spend_intents (
  -- Lowercased on write. Two clients presenting the same hash with different casing are presenting
  -- the same intent, and a case-sensitive key would store it twice and find neither reliably.
  intent_hash   TEXT        PRIMARY KEY,

  intent        JSONB       NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deliberately generous. Long enough that a human-in-the-loop approval between create and preflight
  -- does not expire the quote, short enough that a stale intent cannot be revived weeks later.
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

-- The sweep reads this; without it expiry is a sequential scan over every intent ever created.
CREATE INDEX IF NOT EXISTS untch_spend_intents_expiry
  ON untch_spend_intents (expires_at);
