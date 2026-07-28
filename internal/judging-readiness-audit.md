# Judging readiness audit — Untch, OKX.AI Genesis

**Date:** 2026-07-28
**Auditor:** inspection pass, no modifications made before writing this
**Branch:** `feat/consumer-pack` · **HEAD:** `f047050c3ce84e303664e3a9d70544d2338c4db1`
**Repository:** https://github.com/winsznx/untch — **visibility: PRIVATE**

---

## 0. The headline

Three findings dominate everything else in this document.

| # | Finding | Severity |
|---|---|---|
| **F1** | **The Consumer Pack exists on one laptop.** `feat/consumer-pack` has never been pushed to `origin`. `main` contains zero Consumer Pack files. Production is serving code that has no remote copy. | **P0** |
| **F2** | **The repository is PRIVATE.** Judges cannot read a line of it. Every proof in this document is invisible to the people it is meant to convince. | **P0 — needs your decision** |
| **F3** | **The two open PRs are already merged.** Their head commits are ancestors of `origin/main`. They cannot be merged; leaving them open misrepresents the repository's state to anyone browsing it. | **P1** |

F1 is the one that would actually lose work. A disk failure right now destroys 18 commits, the entire
Consumer Pack, and the only copy of the code currently answering requests at `asp.untch.xyz`.

---

## 1. Repository state

```
branch  feat/consumer-pack
HEAD    f047050c3ce84e303664e3a9d70544d2338c4db1
remote  https://github.com/winsznx/untch.git
```

### Branch topology

| Branch | On origin? | Relationship to `origin/main` |
|---|---|---|
| `main` | yes | `edbfb64` — the deployed-before-this-phase baseline |
| **`feat/consumer-pack`** | **NO** | **18 ahead, 0 behind** |
| `feat/untch-vault` | yes | already merged into main |
| `feat/untch-receipts` | yes | already merged into main |
| `feat/spend-intent-registry` | yes | already merged into main |
| `feat/receipt-writer`, `feat/photon-channel`, `feat/web-onboarding`, `fix/chain-env-typecheck`, `ci/web-coverage` | yes | stale |

### The 18 commits that exist nowhere but here

```
f047050 evidence: production-path execution with a real receipt, and the anchor failure it exposed
49e3857 docs: OKX.AI re-registration package for eight services
1205410 fix(consumer-flags): accept the documented flag names, with the canonical one winning
62cea26 fix(dashboard): gate the two ungated operator pages, and make CSRF explicit
56443d6 fix(consumer-auth): tenant scope now requires proof of policy ownership, not a public identifier
c0172e4 feat(consumer): public shareable receipt with five distinguishable anchor states
a0c7ed7 fix(consumer-receipts): name the reason a receipt was not written, and wire the writer in the live driver
85b3f45 fix(consumer-ledger): stop expensing cross-rail purchases twice
fa71162 feat(consumer-pack): first real settled provider execution, end to end
401d9b3 docs(consumer-pack): pre-activation cold audit findings and disposition
ba8279c fix(consumer-pack): P0/P1 defects found by the pre-activation cold audit
27c9231 docs(consumer-pack): correct the plan — there is no BudgetVault
5d44417 docs(consumer-pack): CI, runbook, threat model, demo — and close the services/asp CI hole
15fa2c0 feat(web): Consumer Pack operator surfaces
c604052 feat(asp): governed consumer execution — orchestrator, funding leg, A2MCP routes
b7a3770 feat(consumer-providers): protocol clients and merchant adapters, built from live captures
9e3e05e feat(consumer-core): safe money, the Consumer Intent state machine, and a double-entry ledger
73f7517 docs(consumer-pack): implementation plan grounded in live provider protocol probes
```

Verified: `git ls-tree -r --name-only origin/main | grep packages/consumer-core` → **0 matches**.
`services/asp/src/consumer` → **0 matches**. Main has none of it.

### Uncommitted changes — all yours, all preserved

```
 M .gitignore
 M internal/day0/D0.1-evidence/402-challenge.json
 M internal/day0/D0.1-evidence/paid-call-transcript.json
 M internal/day0/D0.1-payment-sdk-notes.md
 M internal/untch-prd.md
 M package.json
?? scripts/SUBMIT-OKX-GENESIS.md
?? scripts/SUBMIT-ONCHAIN-OS.md
```

Untouched throughout this phase and not staged into any commit.

---

## 2. The two open pull requests — both already merged

This is not a judgement call. It is a fact about the commit graph.

| PR | Title | Head | Base | State | `git merge-base --is-ancestor <head> origin/main` |
|---|---|---|---|---|---|
| **#2** | §10.3 UntchReceipts — events-only receipt log + timelocked admin | `feat/untch-receipts` @ `7f9eea9` | `feat/spend-intent-registry` | MERGEABLE / CLEAN | **TRUE — already in main** |
| **#3** | §10.4 UntchVault — fund-holding oracle-signed spend vault | `feat/untch-vault` @ `404b146` | `feat/untch-receipts` | MERGEABLE / CLEAN | **TRUE — already in main** |

Both were authored 2026-07-09/10 as a **stacked chain** (`#3` → `#2` → `spend-intent-registry`), and
the whole stack was consolidated into `main` on 2026-07-13. GitHub still reports them MERGEABLE
because their base branches also still exist — it is comparing two stale refs, not asking whether the
content has landed.

**The instruction was to review and merge them. Merging them is not possible in any meaningful
sense**: `git merge origin/feat/untch-vault` into main is a fast-forward to a commit main already
contains, i.e. a no-op. Doing it would produce an empty merge commit and imply work landed today that
landed nineteen days ago.

**Correct action: close both with a comment stating where the content actually landed.** Reviewed
below anyway, because "already merged" is a claim that deserves checking rather than asserting.

### Cold review of the content (post-hoc, since it is already in production)

| Dimension | PR #2 UntchReceipts | PR #3 UntchVault |
|---|---|---|
| Correctness | Events-only log; `receiptId` caller-supplied and gates nothing — documented, and correct for an append-only log | Cross-contract intent check **fails closed** (plain typed call, never `try/catch`); CEI ordering proven by a guard-independent test |
| Security | Custom two-step timelock on writer-set changes, chosen over OZ `TimelockController` after reading its source; adversarially fuzzed invariant that a change proposed at T cannot take effect before T+delay | Vendored OZ ECDSA with malleability guard (`s <= n/2`); `intentRegistry` and token allowlist immutable; owner rotatable two-step |
| Funds at risk | **None** — no `payable`/`receive`/`fallback` (invariant I4) | Holds ERC-20 only; no `payable`/`receive`/`fallback` |
| Migrations | none | none |
| Feature flags | n/a (contracts) | n/a (contracts) |
| Hidden mocks | none — OZ vendored as committed files, byte-for-byte verified against upstream v5.6.1 (`lib/openzeppelin-contracts/VENDORED.md`) | same |
| Secrets | none | none |
| Unsupported claims | Says **testnet only**, mainnet deferred — and that was true at authoring time | Same. Mainnet has since happened separately |
| Deployment impact | **Zero** — already deployed, already in main | **Zero** |

No P0 or P1 issues found. Nothing to fix before closing.

### What actually needs a PR

`feat/consumer-pack` → `main`. **18 commits, currently on no server.** That is the merge this phase
needs, and it does not exist yet.

---

## 3. Deployed production vs repository

| Service | Railway | Last deploy | Serving code from |
|---|---|---|---|
| `untch-asp` → `asp.untch.xyz` | SUCCESS | 2026-07-27 22:30 | **`feat/consumer-pack` working tree** (`railway up` tarball) |
| `untch-web` → `untch.xyz` | SUCCESS | 2026-07-27 22:33 | **`feat/consumer-pack` working tree** |
| `untch-docs` → `docs.untch.xyz` | live (200) | — | main |
| `untch-receipt-writer` | SUCCESS | 2026-07-18 21:24 | main |
| `Postgres`, `Redis` | live | — | — |

**The gap:** Railway deploys a tarball of the working tree, not a git ref. So `asp.untch.xyz` and
`untch.xyz` are running code with **no commit reachable from `origin/main`, and no commit on origin at
all**. There is no way for anyone but me to reproduce the running build.

Live health at time of audit: `asp.untch.xyz/consumer/catalog` **200**, `untch.xyz` **200**,
`docs.untch.xyz` **200**.

---

## 4. CI

Eight workflows: `canon`, `consumer-pack`, `contracts`, `escalation`, `gov-watch`, `policy-engine`,
`receipt-writer`, `web`.

Last runs — all on `main`, all **success**: gov-watch, canon, escalation, web, policy-engine,
receipt-writer.

**`consumer-pack.yml` has never executed.** It was added on `feat/consumer-pack`, which has never been
pushed, so GitHub has never seen it. The Consumer Pack's 193 tests have only ever run on this machine.

---

## 5. Repository metadata

| Field | Current | Required |
|---|---|---|
| Visibility | **PRIVATE** | judges must be able to read it — **your decision** |
| Description | *(empty)* | set |
| Homepage | *(empty)* | `https://untch.xyz` |
| Topics | *(none)* | 14 topics |
| Root `README.md` | **does not exist** | full public README |
| `LICENSE` | **does not exist** | needed before a public release |
| Tags | **none** | semantic version |
| Releases | **none** | one published release |
| Default branch | `main` | correct |
| Merge methods | merge / squash / rebase all allowed | squash preferred for the Consumer Pack PR |

---

## 6. Gap matrix — repository vs production vs public claims

| # | Claim or artefact | Repository | Production | Public docs | OKX.AI listing | Gap |
|---|---|---|---|---|---|---|
| 1 | Consumer Pack code | only on `feat/consumer-pack`, unpushed | **LIVE** | not described | not listed | **P0** — push, PR, merge |
| 2 | Consumer Pack CI | workflow exists, never run | — | — | — | **P1** — runs on push |
| 3 | Public receipt endpoint + page | on branch | **LIVE** (`200`) | absent | absent | **P1** |
| 4 | SIWE ownership proof | on branch | **LIVE**, matrix verified | absent | absent | **P1** |
| 5 | `CONSUMER_AUTH_REQUIRED` | flag implemented | **unset — legacy `?policyId=` bypass open** | — | — | **P0 — §4** |
| 6 | Cross-rail ledger fix | on branch, migrations 008/009 applied | **LIVE**, book balances to zero | absent | — | P2 |
| 7 | Receipt anchoring | code correct | **1 receipt `DEGRADED_UNANCHORED`** — writer wallet holds 0 OKB | — | — | **P0 — §3, needs your funding** |
| 8 | External-funded intent | driver supports it | **never run** | — | — | **P0 — §5, needs `CONSUMER_TEST_FUNDER_PRIVATE_KEY`** |
| 9 | `domains.check` verified | promoted on real evidence | **LIVE**, 2 settled Base USDC txs | absent | not listed | **P1** |
| 10 | `domains.register` / shop / travel / gifts / notify | implemented, gated | **refuse correctly** | — | must NOT be listed as live | ✅ already honest |
| 11 | README | **none** | — | — | — | **P0 — §6** |
| 12 | Changelog | none | — | none | — | **P1 — §8** |
| 13 | Public proof section | none | — | none | — | **P1 — §9** |
| 14 | Repo description / homepage / topics | empty | — | — | — | **P1 — §7** |
| 15 | Licence | **none** | — | — | — | **P1** — blocks a clean public release |
| 16 | Release / tag | none | — | — | — | **P1 — §10** |
| 17 | Repository visibility | **PRIVATE** | — | — | judges cannot verify | **P0 — your decision** |

---

## 7. Blockers that need you, not me

| # | Blocker | What I need | Why I cannot do it |
|---|---|---|---|
| B1 | Receipt-writer wallet holds **0 OKB** | fund `0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5` on X Layer mainnet | Instructed not to generate or transfer funds automatically |
| B2 | External-funder proof | `CONSUMER_TEST_FUNDER_PRIVATE_KEY` for a wallet holding a little USDT0 on X Layer | Not set in `.env`, `services/asp/.env`, or Railway. Generating one and funding it from the treasury would defeat the entire point — the proof is that funder ≠ treasury |
| B3 | Repository visibility | explicit approval to make public | Instructed not to change visibility without it |

Everything else in this phase proceeds without you.

---

## 8. Order of work

1. **Push `feat/consumer-pack`** — stops the single-point-of-failure immediately. *(F1)*
2. Close PRs #2 and #3 with an explanation. *(F3)*
3. Open `feat/consumer-pack` → `main`, let CI run for the first time, merge.
4. Re-deploy from the merged commit so production corresponds to a ref on `main`.
5. §4 mandatory auth — closes the last open authorisation bypass.
6. §6 README, §7 metadata, §8 changelog, §9 proof pages — none of these block on you.
7. §3 and §5 when B1 and B2 clear.
8. §10 release last, from `main`, never from a feature branch.
