# Provider adapters

The typed contract, the maturity ladder, and how to onboard a merchant.

## The contract

```ts
interface ConsumerProviderAdapter {
  readonly providerId: string;
  capabilities(): readonly ProviderCapabilityDescriptor[];
  health(ctx: AdapterContext): Promise<ProviderHealth>;
  discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult>;
  quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote>;
  execute(input: ExecuteInput, payment: PaymentCapability, ctx: AdapterContext): Promise<ProviderExecution>;
  getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus>;
  cancel?(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderCancellation>;
  verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence>;
  normalizeError(err: unknown): NormalizedProviderError;
}
```

`AdapterContext` carries a correlation id, a deadline, the signable rails, a SIWX signer and a
cents-scale discovery capability. **Only `execute` receives spending authority**, and it is scoped to
one intent.

The 402 → select → pay → retry loop lives in `BaseAdapter.paid()`, **once**. Duplicating it per
adapter is how payment verification drifts: five copies of "which `accepts[]` entry do we take"
become five different answers to "is this token on the allowlist".

## Two registries, deliberately separate

| | Question | Backed by |
|---|---|---|
| `ProviderRegistry` (core) | *May* this provider execute right now? | Postgres — maturity, pauses, breakers |
| `AdapterRegistry` (providers) | *Which class* implements it? | a Map |

A provider present in the adapter map but absent from the durable registry can never execute. Adding
a file must not be enough to make Untch spend money.

`assertSeedMatchesAdapters` runs at boot and fails loudly if a seeded capability has no
implementation, or an adapter is not seeded. A capability advertised in the registry with nothing
behind it would be routable and then unfulfillable.

## The maturity ladder

```
verified     a real settled payment from an Untch treasury wallet has been observed AND its
             delivery was verified. ONLY these execute on a production route.
sandbox      adapter implemented, schemas validated against the live spec, protocol shape read from
             a real 402, unit-tested against captured fixtures. NO live settlement.
experimental reachable, but a required leg is unverified — a SIWX identity we do not hold, a rail we
             cannot settle, or a non-idempotent flow with unconfirmed semantics.
disabled     not integrated. Cannot be selected at all.
```

`assertExecutable` throws rather than returning a boolean, because every caller of it must stop and a
boolean invites a caller that forgets to check.

A capability may be **less** mature than its provider (StableDomains is `sandbox` for `check` but
`experimental` for `dns`, which needs a SIWX identity). It may never be **more**:
`effectiveMaturity` takes the minimum, so a capability row cannot quietly promote a provider.

The escape hatch reaches exactly **one rung**. `CONSUMER_ALLOW_SANDBOX_EXECUTION=1` lets a `sandbox`
provider execute in a non-production environment; it is loudly logged, stamped onto the intent, and
surfaced in the UI. `experimental` and `disabled` are never executable under any configuration.

## What ships, and why

| Provider | Maturity | The weakest link |
|---|---|---|
| **StableDomains** | `sandbox` | No settlement has ever been made — no Base treasury key exists. Base USDC + Solana both offered; prices read live (search $0.01, check $0.05, register $20.00). `domains.dns` is `experimental` because it is SIWX-gated and the SIWX leg is unproven. |
| **StableEmail** | `sandbox` | Same: fixed $0.02, Base + Solana confirmed, never settled. |
| **StableTravel** | `sandbox` | **Declares no booking capability at all.** Its own live guidance states it "does not issue tickets, hold reservations, or take payment for travel" and has no hotel/activity/transfer endpoints. It is a flight *data* provider (45 paths). This contradicts `deep-research-report (4).md`, which described 74 endpoints with end-to-end booking. |
| **Purch** | `experimental` | **Solana only.** Every Purch 402 offers exactly one option, on Solana; its OpenAPI says "All endpoints are payable via the x402 protocol (USDC on Solana)". This build cannot construct a Solana payload it can vouch for, so every Purch call — including search — ends at `PROTOCOL_NOT_EXECUTABLE`. |
| **StableMerch** | `experimental` | **SIWX-gated.** `/api/catalog` and `/api/drafts` answer 402 with an *empty* `accepts[]` plus a `sign-in-with-x` extension; only `/commit` is payable. Four of five steps need a wallet identity, and the EIP-4361 rendering this build produces has never been accepted by their verifier. |
| Travala Travel MCP | `disabled` | MCP transport, not an HTTP x402 resource; no endpoint reachable without an MCP session. |
| Trips.sh | `disabled` | No public API documentation of comparable quality. |

Every `provenance` string in `packages/consumer-providers/src/seed.ts` is a factual statement about a
request that was actually made on 2026-07-27. The raw captures are in
`internal/consumer-pack-evidence/` and can be re-fetched with the committed probe scripts.

## The three protocols

**x402 v2** — `PAYMENT-REQUIRED` header, base64 JSON, `accepts[]` of
`{scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra}`. On Base, `extra` is
`{name, version}` — the EIP-712 domain for EIP-3009 `transferWithAuthorization`.

**MPP** — `WWW-Authenticate: Payment id=…, method="tempo", intent="charge", request=<b64>`. Parsed in
full (it matters for telling "MPP-only provider" from "malformed 402"); not executable.

**SIWX** — a 402 with an **empty** `accepts[]` plus `extensions["sign-in-with-x"]`. This is
authentication, not payment. `classifyChallenge` makes the distinction once, explicitly. A client
that reads it as "no acceptable rail" reports the wrong error; one that loops on it never terminates.

## Onboarding template

Copy this checklist into the PR that adds a provider. A row that cannot be filled in honestly is a
row that keeps the provider below `verified`.

```markdown
## Provider: <name>  (providerId: <slug>)

### 1. Live protocol evidence  — attach the raw capture
- [ ] Base URL, https only:
- [ ] `GET /openapi.json` or `/.well-known/x402` fetched on <date>:
- [ ] Every paid endpoint probed unpaid; 402 captured:
- [ ] `accepts[]` rails and assets observed:
- [ ] payTo address(es) observed, per rail:
- [ ] EIP-3009 `extra` domain (EVM rails):
- [ ] Prices observed, per endpoint:
- [ ] MPP `WWW-Authenticate` present? decoded?
- [ ] Any endpoint SIWX-gated (empty accepts[])? which?

### 2. Semantics
- [ ] Which endpoints are non-idempotent?
- [ ] Does the provider accept an idempotency key? what field?
- [ ] Prerequisites before a purchase can succeed (profile, verification, draft):
- [ ] Cancellation supported? endpoint and window:
- [ ] Status endpoint for reconciliation:
- [ ] Independent delivery verification possible? how?

### 3. Registry entry
- [ ] Asset(s) added to `ASSETS` with a dated `confirmedFrom`
- [ ] payTo added to the discovery allowlist (`knownRecipientsFor`)
- [ ] Provider + capability rows in `seed.ts`, each with real `provenance`
- [ ] Per-capability maturity set to the WEAKEST link, not the strongest
- [ ] `assertSeedMatchesAdapters` passes

### 4. Tests
- [ ] Captured 402s committed to `fixtures/`
- [ ] Challenge parsing asserted against the real capture
- [ ] `execute` refuses when a prerequisite is unmet, BEFORE any request
- [ ] A 200 that never demanded payment is refused, not recorded as a settlement
- [ ] Response schema validated; malformed input rejected

### 5. Promotion to `verified` — all four required
- [ ] Treasury key configured and float funded on the provider's rail
- [ ] `pnpm consumer:smoke --provider <slug>` run with a real spend cap
- [ ] A settlement transaction hash recorded, and re-read independently
- [ ] Delivery verified through a path that is NOT the merchant's own assertion
```
