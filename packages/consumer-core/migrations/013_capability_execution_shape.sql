-- How a capability is BOUGHT, recorded on the capability row.
--
-- WHAT WENT WRONG WITHOUT IT
--
-- `ConsumerOrchestrator.quote` calls `adapter.quote()` for every capability, and `PurchAdapter.quote`
-- was written for one shape only: it required `shippingAddress` and `email` and probed `/x402/buy`,
-- the purchase endpoint. `shop.search` has nothing to ship, so the first production proof attempt
-- created its intent, reached the quote stage and died there on a missing shipping address. The
-- capability was marked `verified` on the strength of a real settlement, and that settlement had gone
-- through `discover()` rather than the quote-policy-reserve-execute path, so nothing had ever exercised
-- the combination.
--
-- WHY A COLUMN RATHER THAN A CONDITIONAL
--
-- The alternative was a check on the capability string inside the orchestrator, which would have put
-- provider-shaped knowledge into the provider-neutral layer and would have needed repeating for every
-- future paid read. The shape is a registry fact: the orchestrator reads it and hands it to the
-- adapter, and only the adapter knows what a shape means over the wire.
--
-- NULLABLE, AND NULL MEANS FULFILMENT
--
-- Every row written before this migration meant FULFILMENT, because that is the only thing the code
-- could do. Absence therefore resolves to FULFILMENT rather than to the cheaper path: defaulting to
-- PAID_READ would route a purchase at a read endpoint and silently drop the address a merchant needs.
-- Rows are NOT backfilled for the same reason a provider seed does not re-assert maturity on boot —
-- the resolver's default already expresses it, and a backfill would write a value nobody chose.

ALTER TABLE consumer_provider_capabilities
  ADD COLUMN IF NOT EXISTS execution_shape TEXT;

ALTER TABLE consumer_provider_capabilities
  DROP CONSTRAINT IF EXISTS consumer_provider_capabilities_execution_shape_check;

ALTER TABLE consumer_provider_capabilities
  ADD CONSTRAINT consumer_provider_capabilities_execution_shape_check
  CHECK (execution_shape IS NULL OR execution_shape IN ('PAID_READ', 'FULFILMENT'));
