-- ═════════════════════════════════════════════════════════════════════════════
-- A round trip that proves the sign-in and touches no money
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR
--
-- The static Discord callback cannot be proven from a test suite. A suite can drive the handlers, and
-- it substitutes the one dependency that would place a network call — so it proves the code agrees with
-- itself, and says nothing about whether Discord will accept the registered `redirect_uri`, whether the
-- application id matches, or whether the real code exchange returns the subject the binding expects.
--
-- The only thing that answers those is a real person completing a real OAuth round trip. Doing that
-- with an ACTION link would mean putting a live approval in front of them and trusting that nothing on
-- the page could be pressed, which is a strange way to establish confidence in a payment path.
--
-- So there is a second purpose. A smoke state names a ChannelBinding and NOTHING ELSE: no action
-- reference, no approval request, no token, no amount. The callback that redeems it can verify identity
-- and can not reach a decision, because there is no reference for it to resolve and no token for it to
-- mint. That is a property of what the state carries rather than of the handler remembering to stop.
--
-- WHY IT SHARES THE SPENT-NONCE TABLE
--
-- Because it is the same replay problem and deserves the same answer. Widening the CHECK is what makes
-- the smoke visible in the same audit trail as the real thing — a round trip that was completed, by
-- which subject, at what time — rather than inventing a parallel record that nobody would think to read.

ALTER TABLE untch_approval_oauth_states DROP CONSTRAINT IF EXISTS untch_oauth_state_purpose_known;
ALTER TABLE untch_approval_oauth_states ADD CONSTRAINT untch_oauth_state_purpose_known
  CHECK (purpose IN ('approval_action_v1', 'approval_oauth_smoke_v1'));

-- The action reference is what a real action state names and a smoke state cannot.
--
-- Stated as a CHECK rather than left to the handler, because "the smoke path cannot reach an approval"
-- is the entire claim being made to justify running it against production. A smoke row that carried a
-- reference would mean some code path had aimed one at an approval, and that is worth refusing at the
-- table rather than discovering in a review.
ALTER TABLE untch_approval_oauth_states DROP CONSTRAINT IF EXISTS untch_oauth_state_smoke_is_bare;
ALTER TABLE untch_approval_oauth_states ADD CONSTRAINT untch_oauth_state_smoke_is_bare
  CHECK (purpose <> 'approval_oauth_smoke_v1' OR action_reference_id = '');
