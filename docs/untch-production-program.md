# The Untch production programme

The single implementation reference for taking Untch from a set of individually-working parts to a
product a stranger's agent can complete a journey through.

It exists because the cold relisting audit of 2026-08-01 found something more specific than "the
listing was badly written": every leg of the journey is implemented and several are production-proven,
and the journey still cannot start, because the second step has no public door. This document names
the objects, states the journey, and fixes what each phase must be true before the next one begins.

**Nothing here is a description of what is built.** Where a section describes something that does not
exist yet, it says so. The phase table at the end is the honest map.

---

## 1. The domain

Thirteen objects. Each one exists because something in the journey needs a name for it, and each is
listed with what owns it, what proves it, and what it is *not*.

### UntchAccount

The person or organisation. Opaque id (`acct_` + 26 base32 chars), status, display name, a chosen
default policy, the last policy actually used, and creation/update provenance.

- **Authority:** a verified wallet, and nothing else.
- **Not:** an email. An email authenticates a login provider; it never authorises spending here.
- **Not:** an address either. An account may bind a second wallet or rotate a compromised one, and
  must survive both without every foreign key changing meaning.
- **Never stores:** a password, key material, or an OAuth token.

*Status: table and store shipped (migration 015). Creation through a sign-in is phase 2.*

### WalletBinding

An address bound to an account. `(chainKind, address)` is the key, so one address belongs to at most
one account. Carries `role` (`primary` — the account's authority; `settlement` — a wallet funds move
through, which proves nothing about who may authorise them) and `proofKind` (`siwe` or `declared`).

Exactly one primary EVM wallet per account. At most one Solana wallet. A `declared` binding never
resolves to an account — it is a note, and resolving it would make a note into a credential.

*Status: shipped.*

### MarketplaceBinding

An account's identity on a marketplace: the agent id, optionally a buyer id, and `provenBy`.

`unproven` is the default and is the honest description of an agent id arriving in a request header.
It becomes `wallet-signature` only when the account's own wallet has signed for it. Until then the
binding is **audit context** — which is exactly what it already was, now with somewhere to say so.

*Status: table and store shipped. The signing flow is phase 2.*

### ChannelBinding

A route by which a human is asked to approve something: Telegram, Discord, Slack, the dashboard.

The rule that governs it, established by the binding-lifecycle work and unchanged: **no channel proves
control.** A dashboard code loop proves only that the same browser saw both ends. SIWE is the only real
proof, and a channel is a delivery mechanism attached to an account that has already been proven.

*Status: the escalation channels exist and are proven end to end. Binding them to an ACCOUNT rather
than to a policy partition is phase 2.*

### Policy

The rules a spend is judged against. Registered on `PolicyRegistry`, owned on chain by the user's own
wallet, mirrored durably with its `policyHash`, version, expiry and `onchain_ref`.

A **PolicyDraft** is a policy before it exists: rules, their hash, the agent it will govern, and a
lifecycle of `DRAFT → SUBMITTED → CONFIRMED`. `CONFIRMED` is reachable only from a decoded
`PolicyRegistered` event — a predicted id and a reverted transaction look identical from the server
side.

**The user is the owner. Always.** A server-owned policy would make Untch the owner of every user's
spending rules. See [policy-predecessor.md](./policy-predecessor.md) for why the deployed contract
cannot support a sponsored registration and exactly what change would be required.

*Status: policies and drafts shipped. The registration flow is phase 2.*

### ApprovalRequest / ApprovalDecision

An escalation raised when a decision is neither clearly allowed nor clearly blocked, and the human
answer to it. The request carries what is being asked and the poll reference; the decision carries who
answered, through which channel, and when.

They are separate objects because an approval that was never delivered and one that was delivered and
ignored are different states, and a single "approved: bool" cannot tell them apart.

*Status: production-proven, on real channels. Account-scoped rather than policy-scoped is phase 2.*

### Task

What the user actually wants done, in their own words, plus the provider and capability that will do
it. The thing a person recognises. Everything downstream — the hashes, the intent, the receipt — is
derived from it and refers back to it.

*Status: expressed today as the `task` field of the public preflight request. A durable Task object is
phase 3.*

### ConsumerIntent

The governed unit of execution: one task, one policy decision, one quote, one execution, one
settlement, one verification, one receipt. Has a state machine with terminal states, an idempotency
key, and a tenant.

*Status: production-proven, including a real settled mainnet purchase.*

### ProviderExecution

The record of calling a provider: what was sent, what came back, the classified outcome, and — for the
outcomes that matter — whether the provider may have acted even though the call failed. `AMBIGUOUS` is
a first-class state, because "we do not know whether they did it" is a real answer and treating it as
failure is how one authorisation becomes two settlements.

*Status: shipped and proven.*

### DeliveryVerification

A dated, immutable claim that a delivery met the criteria committed before the work started. Keyed by
`(intentId, verifierVersion, evidenceDigest)`, so re-running over unchanged evidence changes nothing
and a newer verifier writes a new row beside the old one rather than over it.

A receipt is a historical claim. Correcting one is appending a dated verification, never editing the
row.

*Status: shipped (migration 014) and proven.*

### Receipt

The public, shareable record. Built by **naming publishable fields**, so it has nothing to leak: the
request payload, the correlation id and which operator channel resolved an approval are absent by
construction rather than by redaction.

Anchored on X Layer. Two claims get two receipts and two anchors — never one label over both.

*Status: shipped and proven, including public receipt pages.*

### ServiceOrder

A marketplace job: the OKX-side job or task id, the account it belongs to, and the Untch intent it
produced once one exists.

This is the object that makes "a job on OKX" and "an intent in Untch" the same story. Today they
cannot be reconciled at all.

*Status: `untch_marketplace_jobs` shipped. Population is phase 2.*

### RevenueAllocation

What a settlement means commercially: how much of a payment is Untch's fee and how much is a partner's
principal passing through.

**A partner settlement principal is not Untch revenue.** Money that moves through a treasury on its
way to a provider was never earned by Untch, and a schema that cannot say so will eventually produce a
number somebody reports.

*Status: not built. Phase 5.*

---

## 2. The canonical journey

```
OKX social login
   └─ authenticates the user TO OKX. Untch never sees it.
        │
        ▼
OKX Agentic Wallet  ──────────────────────────────► an EVM address
        │
        ▼
SIWE over asp.untch.xyz ─────────────────────────► UntchAccount
   └─ THE authority boundary. Everything above it belongs to OKX;
      everything below it is a claim until a signature crosses this line.
        │
        ▼
Policy  ── draft → the USER's wallet registers → sync from the event
        │
        ▼
Task    ── what you want done, in your words
        │
        ▼
Preflight ── six fields in; the protocol object derived server-side
        │
        ├──► ALLOW    ──┐
        ├──► BLOCK      │  a decision, with the rule that produced it
        └──► ESCALATE ──┤  and a receipt reference
             └─ human answers on a bound channel
                        │
                        ▼
                    Execute ── provider called, outcome classified
                        │
                        ▼
                    Verify  ── against criteria committed BEFORE the work
                        │
                        ▼
                    Receipt ── anchored, public, shareable
                        │
                        ├──► Dashboard: the account's own view
                        └──► Marketplace: the job reconciled to the intent
```

### The invariants this journey rests on

Each of these is a rule that something in the system currently enforces, or that phase 2 must make it
enforce. They are stated as prohibitions because that is how they are checked.

1. **Social email authenticates OKX, not Untch spending.** Untch never receives it and has nowhere to
   store it. Verified by absence.

2. **Wallet proof establishes Untch authority.** A SIWE signature over a server-issued, single-use,
   expiring nonce, verified against a chain the deployment can actually reach. Nothing else creates an
   account and nothing else authorises a scoped read.

3. **Gmail or mailbox OAuth is a capability, never authority.** A mail grant lets a provider send on
   the user's behalf. It cannot approve a payment, cannot mint a session, and cannot identify an
   account.

4. **Marketplace identity is audit context until it is bound to a wallet.** An agent id in a header is
   a claim. `provenBy: 'unproven'` is the schema saying so, and it is the field an authorisation check
   reads — so an unproven binding authorises nothing by construction.

5. **A partner settlement principal is not Untch revenue.** Value passing through on its way to a
   provider was never earned here.

6. **X Layer receipts reference Base or Solana settlement.** The receipt is the commitment; the
   settlement happened elsewhere and says so, with the chain named.

7. **External settlement does not move back to X Layer.** Nothing claims funds return. A receipt on X
   Layer that referenced a Base settlement and implied a return leg would be describing a bridge that
   does not exist.

### Where the journey currently breaks

Step 2. There is no public route that creates a policy, so a marketplace agent cannot reach step 3 at
all. Every leg after it is individually implemented and several are production-proven. This is why the
programme is ordered the way it is: the phases below are sequenced by what unblocks the journey, not by
what is most interesting to build.

---

## 3. Phases and exit gates

A phase is done when its gate is provable, not when its code is written.

### Phase 1 — Integrity and the contract (this pass)

Close the security and truth defects, make the published contract the enforced one, and lay the
account and policy data model.

**Exit gate**

- [x] Serving commit attested and equal to `origin/main`.
- [x] Sign-in accepts only chains this deployment can reach; the retired testnet is refused by name.
- [x] One generated chain registry; CI fails on drift; a scanner refuses production-visible testnet
      values in the repository and in what the deployment serves.
- [x] No route returns Express HTML, at any status, including when the facilitator is unreachable.
- [x] Unknown internal errors return a code and a correlation id, and carry no stack, SQL, provider
      body or secret.
- [x] Every public service has one typed definition; `/schema/:tool`, `/openapi.json` and
      `/.well-known/x402` are generated from it and free to read; CI fails on drift.
- [x] Every generated description has all three parts OKX requires and cites no private section number.
- [x] A service whose predecessor nobody can obtain is withheld from the listing payload, with the
      reason recorded.
- [x] The two rejected contracts ask for what a caller knows; everything else is derived, and what
      cannot be derived is refused by name.
- [x] Account, wallet-binding, marketplace-binding and policy-draft tables exist, with the migration
      path proven not to touch an existing policy, intent or receipt.
- [x] A redacted rotation plan exists for every credential the audit could read.

### Phase 2 — The door (next pass)

Make the journey startable. Account linking, policy registration, the approval centre, channel and
marketplace binding.

**Exit gate**

- A wallet can sign in and get an account, and the same wallet always resolves to the same one.
- A user can draft a policy, register it from their own wallet, and see it confirmed from the event.
- `GET /policy/:policyId` returns `policyHash`, so it stops being an unobtainable predecessor.
- A default policy can be chosen, and `useDefaultPolicy` resolves against it.
- An escalation reaches a bound channel and the answer returns, scoped to the account.
- A marketplace agent id can be proven by a wallet signature and stops being audit-only.
- Both previously-rejected services become listable **because their predecessors became obtainable**,
  not because anyone edited a description.

### Phase 3 — The paid journey end to end

Task, quote, execution, verification and receipt as one governed flow a marketplace caller can drive.

**Exit gate**

- One paid marketplace call completes the whole journey with real settlement and an anchored receipt.
- A replayed identical request returns the first result and does not double-charge.
- The dashboard and the marketplace both show the same job, reconciled to the same intent.

### Phase 4 — The Builder Pack

See §4. Not started, and deliberately not started: it depends on the account and execution foundation
above.

**Exit gate:** the acceptance criteria in §4.

### Phase 5 — Commercial truth

RevenueAllocation, differentiated pricing, and reporting that distinguishes fee from principal.

**Exit gate**

- Every settlement is attributed to fee or principal, and no report adds them together.
- `reconcile_agent_spend` charges its documented day and week rates rather than one rate for both.

---

## 4. Deferred: the Builder Pack (phase 4)

**Recorded here so it does not disappear.** None of this is implemented, and nothing in it may be
implemented until phase 4 is explicitly in scope.

The Builder Pack must compose **two versioned skills**, in order:

### 4.1 `brand-naming` — not built, must be built separately

Target style: **Untch · Nulth · Kyrve · Tidyr · Syrty** — short, compressed, pronounceable,
orthographically distinctive.

Must reject: **FlowLabs · NexaVerse · PayBotAI · ChainFlow**, and generic `ai` / `bot` / `labs` /
`chain` / `verse` / `nexa` / `flow` constructions, along with `-ly` / `-io` / `-hq` / `-sh` suffixes.

Required components:

- product and semantic-root extraction
- phonetic scoring
- visual and orthographic scoring
- pronunciation clarity
- distinctiveness scoring
- banned-stem and suffix filtering
- category collision checks
- domain checks
- social-handle checks where supported
- trademark-risk warnings
- deterministic ranking, with a stable seed
- a human final-selection gate

The current implementation is not this. `rankBrandNames` scores length, charset, single-token-ness,
pronounceability and title-case, and never applies the ban list — `isBannedBrand` is imported by the
name generator and by a test, and by nothing else. Live, it ranks FlowLabs, Kyrve, NexaVerse and
PayBotAI equal-first on 113 and puts Untch seventh on 93, penalised as hard to say. The paid
`brand_pack` calls that ranker.

### 4.2 `brand-design` — the attached skill, audited, not vendored

The attached `brand-design` skill (v1.0.0, author `winszn`, MIT) is the **future visual-production
engine** for the Builder Pack. It is referenced here and **not copied into this repository** in this
pass.

Read as a specification, it is sound and it is stricter than what exists: inspect before inventing;
resolve one source of truth; editable SVG masters first; explore genuinely distinct concepts before
polishing; lock the system then derive; exact values over approximations; an explicit anti-slop gate;
validation at real sizes, in monochrome, on real surfaces; and — the clause that matters most for a
paid endpoint — *"never claim an asset exists when only a prompt or concept was produced."*

Given a selected name it must produce: `design.md`, `brand.json`, logo and symbol SVG masters, a
wordmark, a favicon, an app icon, a social avatar, an OG image, transparent PNG exports, an asset
manifest, and a validation report.

Two things to note before integrating it. Its bundled validators are Python and optional, so a
production integration cannot assume they ran — the execution boundary has to assert on outputs, not
on the skill's good intentions. And it depends on a `references/` tree that is not present here; the
attached file is the SKILL.md alone, with `brand-design.zip` recorded only as a checksum
(`d6f10cda…60ea9`, alongside `1080fc2b…19e7` for the SKILL.md itself). Vendoring must bring the
referenced files or the links are dead.

### 4.3 The execution boundary

The Builder Pack endpoint must call both skills through a **versioned, testable execution boundary**.

It must not paste a skill into an LLM prompt and report that files were created.

**Acceptance criteria — all of them, before the endpoint may be sold:**

1. Each skill is invoked at a **pinned version**, and that version is recorded in the response and in
   the receipt.
2. The boundary returns **actual artefacts** — files, with paths and content hashes — and the caller
   can fetch every one of them.
3. Every claimed artefact is **verified to exist** before the response is written. A response naming a
   file that was not produced is a failure of the endpoint, not a caveat in its output.
4. An **asset manifest** lists every deliverable with its hash, and the manifest hash is what the
   receipt commits to.
5. A **validation report** is produced and returned, including failed gates. A pack that fails its own
   quality gates must say so rather than shipping quietly.
6. The boundary is **testable without a model**: a fixture-driven run must exercise the whole path and
   assert on the artefacts, so a regression is caught without spending money on inference.
7. `brand-naming` runs first and its **human selection gate** is respected — `brand-design` receives a
   *selected* name, never a list.
8. Ranking is **deterministic given a seed**, and the seed is returned, so two callers with the same
   input get the same order and a disputed result can be reproduced.
9. The domain and handle checks report **UNKNOWN** where they do not know. The current RDAP client
   treats HTTP 400 and 422 as `available: true` and reports `untch.xyz` — this product's own live
   domain — as available for purchase.
10. Nothing in the response claims a trademark clearance. Trademark-risk warnings are warnings.

Until all ten hold, `brand_pack`, `check_domains` and `rank_options` stay marked `blocked` in the
service registry and withheld from the listing.

---

## 5. What is deliberately not in this programme

- **Changing the live OKX listing.** Not in phase 1. The listing payload is generated and committed;
  submitting it is a separate, approved act.
- **Any mainnet transaction.** No policy registration, no governance execution, no contract deployment.
- **Secret rotation.** The plan exists at `internal/secret-rotation-plan.md` and is deliberately
  **not tracked** — `internal/` is gitignored, and a public repository is the wrong place for a
  document that ranks this deployment's credentials by how much damage each one does. Executing it
  needs an approved maintenance window.
- **Enabling a disabled provider or Solana execution.** Both are off, deliberately, and turning either
  on is a decision with money attached.

---

## 6. The pass plan

Phases (§3) say what must become TRUE. Passes say what gets BUILT, and in what order, by whoever picks
this up next. They are not two plans — a pass ends when the phase gate it was aimed at is provable.

### PASS 3 — the visible slice

Core completion, a wallet-owned mainnet policy, web approvals, the Explorer, the owned-work runtime,
artifact delivery, and one owned service shipped through all of it.

- account-derived preflight and delivery verify, served rather than only published
- a policy the user's own wallet registered on chain 196, synced and selected as their default
- the approval centre as a web surface, not only an API
- the activity Explorer as a case-first evidence plane over migration 018
- `@untch/owned-work`: service definitions, orders, work intents, plans, nodes, checkpoints,
  evidence claims, delivery manifests
- Untch-owned artifact storage and static-site releases
- Battle Card, end to end, producing files that exist

### PASS 4 — the rest of the owned services

`brand-naming` and `brand-design` as versioned skills behind the execution boundary of §4.3, then
Builder Package, GTM Package, Find Contacts, Harden, Edge, and scheduling and reruns. Each one runs on
the PASS 3 runtime; none of them gets its own private idea of what a plan, a checkpoint or a delivery
is.

### PASS 5 — the paid rails and the commercial record

Gifts, shopping, domains, mail, and travel where the access is real. Provider execution. The
accounting proof that separates fee from principal. ERC-8004 onboarding. Sentinel, observe-only. The
receipt archive. Final marketplace conformance and the regenerated listing.

### Excluded from every pass

**Cordon.** It is a separate product — an inbound payment compliance firewall on Monad testnet,
dependent on Cleanverse A-Pass and A-Token — and the V2 addendum's description of it as an integrated
payload firewall was wrong. See [ADR-cordon-is-not-an-untch-module](./adr/ADR-cordon-is-not-an-untch-module.md).
The module slot it occupied is now the owned-work runtime.

**Swarm governance, bonds, negotiation and guardian consensus.** Later V2 work, and only once the
earlier product is complete and proven. Each of them is a mechanism for coordinating agents that
already work; none of them makes an agent work.
