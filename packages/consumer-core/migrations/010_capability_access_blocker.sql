-- Consumer Pack: why a capability is stuck, when the reason is not "Untch has not finished it".
--
-- The maturity ladder answers "may this execute?". It cannot answer "whose problem is it?", and
-- those are different questions with different consequences. An adapter we have not finished and a
-- merchant that will not admit us without a partner agreement both sit at `experimental`, and a
-- public surface that renders them identically lets unfinished work hide behind the merchant.
--
-- Nullable and defaulting to NULL, so every existing row keeps meaning exactly what it meant: no
-- external blocker, the remaining work is ours. Nothing in the execution gate reads this column —
-- `assertExecutable` still reads `maturity` alone — so it can never be edited into permission.

ALTER TABLE consumer_provider_capabilities
  ADD COLUMN IF NOT EXISTS access_blocker TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consumer_provider_capabilities_access_blocker_check'
  ) THEN
    ALTER TABLE consumer_provider_capabilities
      ADD CONSTRAINT consumer_provider_capabilities_access_blocker_check
      CHECK (access_blocker IS NULL OR access_blocker IN (
        'PARTNER_ACCESS',
        'IDENTITY_REQUIRED',
        'RAIL_UNAVAILABLE',
        'PROVIDER_UNSUPPORTED'
      ));
  END IF;
END
$$;
