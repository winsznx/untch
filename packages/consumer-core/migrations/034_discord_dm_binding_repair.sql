-- ═════════════════════════════════════════════════════════════════════════════
-- A user id is not a channel
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS REPAIRS
--
-- The Discord OAuth link flow wrote the verified USER id into `channel_chat_id`, under a comment
-- saying a DM channel would be opened at send time. The comment described the intent; the value
-- defeated it. `channel_chat_id` is what the gateway reads to decide whether it has a real channel,
-- so a populated one meant "post to this channel" — and the channel it posted to was a user id.
--
--     POST /channels/<discord user id>/messages   ->   404 Unknown Channel
--
-- Terminal, non-retryable, every time. On 2026-08-05 a paid approval request reached PENDING, its
-- outbox event was written and claimed, and the message was never sent. The fee had already settled.
--
-- WHY NULL IS THE CORRECT VALUE AND NOT A GUESS
--
-- An `identify` OAuth grant proves WHO somebody is. It conveys no channel, no guild and no DM — the
-- DM is opened at send time against the user id, which is exactly what the original comment said.
-- So for these bindings there IS no channel, and NULL is the only honest recording of that. Anything
-- else is a channel nobody verified.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--
-- `channel_user_id`. That identity was verified by a real OAuth round trip and is what every approval
-- refusal compares against; rewriting it would be rewriting the proof. Only the delivery destination
-- is wrong, and only the delivery destination is corrected.

-- The predicate carries every condition from the repair scope, so a binding that earned its
-- `channel_chat_id` some other way keeps it. A row is only touched when the recorded channel is
-- LITERALLY the user id — which is not a channel any flow could have verified.
UPDATE untch_channel_bindings
   SET channel_chat_id = NULL,
       updated_at = now(),
       updated_by = 'migration-034-dm-repair'
 WHERE channel = 'discord'
   AND verification_method = 'discord_oauth_identify'
   AND channel_chat_id IS NOT NULL
   AND channel_chat_id = channel_user_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- And it cannot come back
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The link flow no longer writes the user id, and a data repair that relies on the writer staying
-- fixed is a repair with a half-life. This makes the bad shape unrepresentable: an OAuth-identify
-- Discord binding may hold NULL, or a channel that is not the user id, and nothing else.
--
-- Stated as a CHECK rather than a trigger because it is a fact about a row, and a row-level fact
-- belongs where the row is defined.
ALTER TABLE untch_channel_bindings DROP CONSTRAINT IF EXISTS untch_channel_identify_has_no_channel;
ALTER TABLE untch_channel_bindings ADD CONSTRAINT untch_channel_identify_has_no_channel
  CHECK (
    channel <> 'discord'
    OR verification_method IS DISTINCT FROM 'discord_oauth_identify'
    OR channel_chat_id IS NULL
    OR channel_chat_id <> channel_user_id
  );
