# ADR — Cordon is not an Untch module

**Status:** Accepted
**Date:** 2026-08-02
**Supersedes:** "Module A — Cordon Payload Firewall (Surface S22)" in the Untch V2 PRD Addendum

---

## The claim being withdrawn

The V2 addendum described Cordon as a deterministic **inbound payload firewall** integrated into the
Untch lifecycle: a classifier sitting in front of `create_spend_intent` and in front of the Proof
Engine, returning `ALLOW` / `SANITIZE` / `BLOCK` on untrusted content, detecting prompt injection,
payout-address hijacking, secret exfiltration, instruction embedding and schema smuggling. It carried
an invariant (I11), two new lifecycle insertion points, a new terminal state
(`VERIFY_FAILED_PAYLOAD_UNSAFE`), a `cordon_verdict` receipt column, two priced tools
(`scan_payload`, `audit_endpoint`), a P0 build priority, and the line **"Cordon is already built."**

None of that describes Cordon.

## What Cordon actually is

An **inbound payment compliance firewall**. A different product, solving a different problem, on a
different chain:

- it screens **incoming deposits**, not agent payloads;
- it depends on **Cleanverse A-Pass and A-Token** for sender identity and clean-funds circulation;
- it is deployed on **Monad testnet**;
- it operates a **holding / operating / quarantine** wallet model;
- it checks **sender identity, tier, group, freshness and blacklist status**;
- it emits **`DepositCleared`** and **`DepositQuarantined`** verdicts on chain;
- in the referenced implementation, **physical token sweeping was not complete**.

The overlap with the addendum's description is the word "firewall". Everything else — the inputs, the
verdicts, the chain, the dependencies, the threat model — differs.

## Why this matters more than a documentation error

Three things followed from the wrong description, and each is worse than the description itself.

**A P0 with no work in it.** "Cordon is already built" made Module A a formalisation task —
integrate, add a column, ship. The actual work of building an inbound-payload firewall for Untch is
unstarted, and a roadmap that ranks it P0-because-done hides that from whoever plans the next pass.

**An invariant nothing enforced.** I11 stated that no inbound payload reaches the policy engine, the
proof engine or the receipt writer without passing Cordon's check. It has never been true, cannot be
true — the component it names does not do that — and an invariant that cannot be violated by any
code path is not a safety property, it is a sentence.

**A capability claim to a marketplace.** `scan_payload` and `audit_endpoint` were listed as priced
tools of a component that does not perform that function. Publishing them would have been selling a
scan nothing performs.

## Decision

1. **Cordon is not an Untch runtime dependency.** No Untch code path calls it, and none is planned.
2. **Cordon is not an Untch provider-payload scanner.** It never was one.
3. **Cordon is not a current X Layer feature.** It is deployed on Monad testnet and depends on
   Cleanverse infrastructure that has no X Layer presence.
4. **Its contracts are not copied into this repository.** A Monad-testnet deposit-screening contract
   in `contracts/` would be a component nothing deploys and nothing tests, which is how a repository
   acquires code that looks maintained.
5. **Nothing claims Cordon supports Untch.** Not the PRD, not the listing, not the docs.
6. **Cordon is preserved as a sibling product.** It is real and it works on its own terms; the error
   was importing it into an architecture it does not belong to. It keeps its own repository, its own
   roadmap, and its own claims.

## What replaces Module A

**Untch Owned Work Runtime and Artifact Delivery.** The slot is not left empty, and it is not filled
with a second security module: it is filled with the thing every deferred owned service in §4 of the
production programme actually needs — service definitions, orders, work intents, plans, nodes,
checkpoints, evidence claims, artifacts, site releases and delivery manifests. See
`packages/owned-work`.

The choice is deliberate. The addendum's priority table put a defensive integration at P0 ahead of the
runtime that six revenue-bearing services depend on, on the strength of a claim that the defensive
work was already done. With that claim withdrawn, the ordering has no support left.

## If Untch needs ingress safety later

Treat it as a **new subsystem with independent requirements**, not as an integration of an existing
product. It would need its own threat model written against Untch's actual inputs — provider delivery
payloads, A2A responses, marketplace task descriptions — its own deterministic rules, its own test
corpus of real attacks, and its own decision about what a `SANITIZE` verdict means for a hash that has
already been committed to. None of that is inherited from a deposit-screening firewall, and starting
from one would produce a component shaped like the wrong problem.

The one design note worth carrying forward, because it is true regardless of which product implements
it: **a sanitised payload has a different hash than the one that was received**, and a lifecycle that
commits to a delivery hash before sanitising has to decide, explicitly, which of the two the receipt
is a claim about. The addendum did not say. Whoever builds this must.

## Consequences

- The V2 addendum is corrected: Module A removed from the module list, the lifecycle diagrams, the
  priority table and the tool-pricing table; I11 withdrawn; `VERIFY_FAILED_PAYLOAD_UNSAFE` and
  `cordon_verdict` removed as planned schema.
- No Untch receipt, schema, event or migration references Cordon. (None ever did — the integration
  was planned, never built, which is the only reason this correction is cheap.)
- The competitive note about Warden (OKX.AI ASP #3808) is retained as market context and detached
  from any claim that Untch ships a competing scanner.
