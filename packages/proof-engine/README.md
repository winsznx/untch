# @untch/proof-engine

Deterministic delivery-verification engine (PRD §13 / §7.3). Given a delivery, the intent's committed
acceptance criteria, and the required proof tier, it returns a machine-readable verification outcome —
with **no LLM anywhere** (invariant I1). Every check is pure, deterministic code, same as the policy
engine's own rules: the same delivery + criteria always yield the same verdict and the same diffs.

> **This is a PARTIAL implementation — a slice of the full §13 Proof Engine, not the whole thing.**
> **One of §13's five tiers is real: T0 (Schema Proof).** The other four — **T1 (Trace), T2 (Source),
> T3 (TEE), T4 (Evaluator/Dispute)** — are explicit **stubs**: each returns `NOT_IMPLEMENTED`, tagged
> `implemented: false` in the tier ladder, so a stubbed tier is never silently skipped, never silently
> absent, and **never faked as `PASS`** (the HARD RULES). This mirrors exactly how
> `@untch/policy-engine` stubs its unbuilt RULE_EVAL rules. A manifest test
> (`test/manifest.test.ts`) pins precisely which tiers are real (T0) and which are stubbed (T1–T4), so
> nobody mistakes this slice for the complete engine.

## What's real vs stubbed

| Tier | Name (§13) | Status | Mechanism / why deferred |
|---|---|---|---|
| **T0** | Schema Proof | **real** | ajv schema + required-field / size / regex / enum field checks + exact-hash for deterministic deliverables, plus acceptance-criteria binding |
| **T1** | Trace Proof | stub | needs a vendor/worker signing-key registry ("registered at index time", §13); no registry and no real vendor to register yet |
| **T2** | Source Proof | stub | needs a real source-manifest concept (§13); not built yet |
| **T3** | TEE Proof | stub | needs a TEE attestation adapter registry (§22.7); not built yet |
| **T4** | Evaluator/Dispute | stub | needs the dispute-packet + arbitration ingest (§7.6/§13); not built yet |

Why T1/T2 are the deferred pair called out first: T1 needs a key registry that does not exist and
that nothing in this build has a real vendor to populate; T2 needs a source-manifest concept with the
same gap. Building either now would mean inventing a fake registry to satisfy a tier nothing could
actually exercise. **T0 has no such gap** — it checks the acceptance criteria already committed at
intent time (the §8.1 `acceptanceHash`, which this build already threads through the `intentHash`).

## What T0 checks (§7.3)

In order (only the criteria-binding failure short-circuits; every other check runs so the caller gets
**all** diffs at once, matching §7.3's `VERIFY_FAILED{diffs[]}`):

0. **criteria binding** — `hashCanonicalJson(criteria)` (RFC 8785, §9) MUST equal the committed
   `acceptanceHash`. A mismatch means the presented spec is not the one committed → `FAIL`. This is
   what stops a buyer swapping criteria after seeing the delivery.
1. **ajv schema** — the payload validates against `criteria.schema`.
2. **required fields** — every `criteria.requiredFields` dot-path is present.
3. **size bounds** — the payload's canonical-JSON byte length is within `[minBytes, maxBytes]`.
4. **field constraints** — per-field regex (anchored by default) / enum / length.
5. **exact hash** — for a fully-deterministic deliverable, the payload's canonical keccak256 equals
   `criteria.exactHash.value` (works from an opaque `payloadHash` too).

## Terminal outcomes (§7.3)

- `VERIFY_PASSED` — every tier ≤ REQUIRED passed → recommend **RELEASE**.
- `VERIFY_FAILED` — T0 schema/conformance failed → recommend **WITHHOLD**, with `diffs[]`.
- `VERIFY_SKIPPED_UNCOMMITTED` — the intent committed **no** `acceptanceHash` (`0x0`, §8.1) → a logged
  **buyer-hygiene event** (§7.3), never silently ignored and never a pass.
- `VERIFY_TIER_NOT_IMPLEMENTED` — the policy required a tier this slice does not run (T1+). We cannot
  honestly claim `PASS`, so this is its own terminal state — **never a silent pass** (HARD RULE).

REQUIRED_TIER is **T0 (0)** in this build: policy-driven tier escalation (§8 `proof.requireTierAbove`)
rides with the still-stubbed `proof.tierRequired` policy rule and the T1+ tiers themselves.

## On-chain result codes

`VerifyOutcome.verifyResultCode` / `proofTier` are the exact uint8s the §10.3 `ReceiptLogged` records
(consumed by `@untch/receipt-writer`'s `draftFromVerify`). `UNVERIFIED = 0` is **frozen** — it is the
default every prior (decision-kind) receipt has carried. The non-zero codes (`PASS=1`, `FAIL=2`,
`SKIPPED_UNCOMMITTED=3`, `NOT_IMPLEMENTED=4`) are what a real `verify_delivery` records for the first
time.

## Design notes

- **Reuses `@untch/canon` (§9) — never reimplements hashing.** The criteria-binding hash and the
  exact-hash check are `hashCanonicalJson` (RFC 8785); the payload size is the byte length of the same
  canonical string, so the size checked and the hash committed never drift.
- **No infrastructure.** The engine takes the delivery, criteria, and committed hash as arguments; it
  runs with zero external services and tests with nothing running.
- **Deterministic, no LLM (I1).** ajv is configured `allErrors:true` for a stable, complete diff list;
  regex/enum/size/exact-hash are hand-rolled deterministic checks.

## API

```ts
import { verifyDelivery } from "@untch/proof-engine";

const outcome = verifyDelivery({
  intentHash,
  acceptanceHash,          // the committed §8.1 value (0x0 ⇒ VERIFY_SKIPPED_UNCOMMITTED)
  criteria,                // the acceptance-criteria doc (must hash back to acceptanceHash)
  delivery: { payload },   // and/or { payloadHash } for exact-hash-only deliverables
  // requiredTier: 0,      // default T0; a higher tier ⇒ VERIFY_TIER_NOT_IMPLEMENTED
});
// → { final, recommendation, tierResults[], diffs[], verifyResultCode, proofTier, payloadHash, … }
```

## Test & build

```sh
pnpm --filter @untch/proof-engine typecheck   # tsc --noEmit
pnpm test:proof                               # node --import tsx --test (from repo root)
```

The suite covers each T0 check with a pass **and** a fail case, the boundary cases (size, regex/enum
length), exact-hash match/mismatch (payload and opaque-hash), the criteria-binding integrity path, the
uncommitted buyer-hygiene path, and the tier manifest — which asserts, from two independent sources
(the exported constants and a live outcome's ladder), that exactly T0 is real and T1–T4 are stubbed.
