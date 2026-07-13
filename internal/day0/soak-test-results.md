# §28 Testnet soak — results

**Gate:** PRD §28 "Testnet soak: ≥50 full real cycles on X Layer testnet across all decision outcomes
(approve / block / escalate-approve / escalate-timeout / verify-fail-withhold), plus a pause drill and
an oracle-key rotation drill executed end-to-end."

**Status:** **CORE COMPLETE — all five outcome types + both drills executed for real on a testnet-1952
fork (§2–§4). Public-testnet execution PREPARED as an exact, eth_call-preflighted signing bundle
awaiting the human's own-wallet signatures (§7); mainnet x402 subset remains (§6).**
**Date:** 2026-07-13 (fork layer) · public-bundle prepared 2026-07-13
**Method discipline:** every number below is either the output of a real engine/EVM execution in this
session or an independent raw read (`cast` / re-derived hash) — never the harness asserting its own
success. Nothing is simulated or fabricated. Where a step genuinely could not run in this environment
(a key the human holds), it is listed as REMAINING, not glossed.

---

## 0. The testnet/mainnet split — CONFIRMED (with the flow read, not assumed)

The task's reasoning was checked against the actual code and PRD §7, and it **holds, with one material
correction about *where the money-movement lives* that makes even more of the soak testnet-runnable.**

**Confirmed — the decision precedes settlement.** `evaluateIntent` ([packages/policy-engine/src/evaluate.ts](../../packages/policy-engine/src/evaluate.ts))
is a **pure, deterministic, I/O-free** function: intent → canonicalize → policy-active → state-assembly →
RULE_EVAL → a §8.2 `Decision`. It runs **before** anything settles. PRD §7.1 is explicit — `REJECTED_MALFORMED
(no charge)`, and "Every terminal state, including every BLOCKED_*, queues a receipt". §7.2: an escalation
that times out → `EXPIRED → default DENY (I2)`. §7.3: a T0 verify FAIL → `recommend WITHHOLD`. So:

| Outcome | Reaches settlement? | Therefore runnable on… |
|---|---|---|
| **block** (`BLOCKED_*`) | No — withheld at decision | testnet / off-chain |
| **escalate-timeout** (`ESCALATED_* → EXPIRED`) | No — default DENY | testnet / off-chain |
| **verify-fail-withhold** (`APPROVED` → verify FAIL) | No — WITHHOLD, oracle never signs | testnet / off-chain |
| **approve** (`APPROVED` → settle) | Yes | settlement piece only |
| **escalate-approve** (`ESCALATED_* → APPROVED` → settle) | Yes | settlement piece only |

**Correction that helps:** the "settlement" for an approved cycle is **not necessarily** the mainnet-only
x402 charge. Untch has two settlement surfaces (§14):
- **x402 A2MCP** (OKX hosted facilitator) — **mainnet-only**; no testnet facilitator exists (D0.1,
  re-confirmed three ways). This is the *only* piece that strictly needs mainnet.
- **UntchVault Mode C** ([contracts/src/UntchVault.sol](../../contracts/src/UntchVault.sol) `spend()`) — a
  plain X Layer contract, **already deployed and exercised on testnet 1952**
  ([untch-vault-testnet-receipt.json](../deploy/untch-vault-testnet-receipt.json)). An approved cycle's
  on-chain money movement runs on testnet here. `spend()` is authorized by the **oracle signature**, not
  `onlyOwner` — verified at [UntchVault.sol:396-437](../../contracts/src/UntchVault.sol#L396).

**Net:** all five decision outcomes and both drills run on testnet; the mainnet requirement collapses to
the single x402 charge, which D0.1 already proved real on mainnet
(tx `0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc`, X Layer 196, block 64815585).

**One honest constraint discovered (not in the task's framing):** broadcasting to *public* testnet 1952
needs the vault **owner's private key**, which is **not present in this environment** — `.env` carries only
the OKX HMAC triple, the **public** ops-wallet address (`0x98F4…3c0b`, which is the vault owner), and
notification tokens. The ops wallet is funded (~0.17 testnet OKB, read live) but its key is human-held and
uncommitted, exactly as every prior on-chain proof required (`prove-policy-onchain.ts` documents the same
"run with your key" boundary). So the on-chain layer runs against an **anvil fork of testnet 1952** — the
**real deployed vault, real bytecode, real state, real oracle sigs, real reverts** — with the owner
*impersonated* (an anvil capability) instead of key-signed. This is genuine EVM execution against the
production contract; the only thing it cannot do is write the public 1952 ledger. That public-ledger
broadcast is the documented REMAINING step (§5).

---

## 1. The harness (built, not 50 hand-triggered txs)

Reuses the real packages end-to-end — no reimplementation:

| File | What it does | Reuses |
|---|---|---|
| [scripts/soak/fixtures.ts](../../scripts/soak/fixtures.ts) | Deterministic intent/policy/criteria builders | `@untch/canon`, engine types |
| [scripts/soak/decisions.ts](../../scripts/soak/decisions.ts) | Drives all 5 decision outcomes for real | `@untch/policy-engine`, `@untch/escalation`, `@untch/proof-engine` |
| [scripts/soak-decisions.ts](../../scripts/soak-decisions.ts) | Runner → JSONL + summary evidence | — |
| [scripts/soak/onchain.ts](../../scripts/soak/onchain.ts) | Vault spends + withhold proof + both drills | deployed `UntchVault`, oracle EIP-712 |
| [scripts/soak/run-onchain.sh](../../scripts/soak/run-onchain.sh) | Forks testnet, runs harness, independent `cast` readback | `anvil`, `cast` |

Run: `pnpm soak:decisions` · `pnpm soak:onchain`. Both are idempotent and reproducible.

---

## 2. Decision cycles — 56 real (≥50), all five outcomes

Executed via `pnpm soak:decisions`. Each cycle runs the real engine; the `intentHash` is **independently
re-derived** with a second `hashSpendIntent` call and asserted equal to the engine's, and escalation
outcomes are read back from the escalation **repo record** (not the inbound return). Full per-cycle log:
[soak-evidence/decisions.jsonl](soak-evidence/decisions.jsonl) · summary:
[soak-evidence/decisions-summary.json](soak-evidence/decisions-summary.json).

| Outcome type | Cycles | Real terminal codes observed |
|---|---:|---|
| **approve** | 12 | `APPROVED` |
| **block** | 14 | `BLOCKED_BUDGET`, `BLOCKED_PER_CALL_CAP`, `BLOCKED_CATEGORY`, `BLOCKED_RECIPIENT`, `BLOCKED_AGENT`, `BLOCKED_INTENT_BOUND`, `BLOCKED_NO_ACTIVE_POLICY` (2 each) |
| **escalate-approve** | 10 | `ESCALATED_THRESHOLD` → escalation repo `APPROVED` |
| **escalate-timeout** | 10 | `ESCALATED_THRESHOLD` → clock past TTL → escalation repo `EXPIRED` (default DENY) |
| **verify-fail-withhold** | 10 | `APPROVED` → `verifyDelivery` → `VERIFY_FAILED` / `WITHHOLD` |
| **TOTAL** | **56** | 0 failures; every `intentHashVerified: true` |

Not 50 repeats of one path: the block family alone spans **7 distinct** `BLOCKED_*` rules, and the two
escalation types diverge on the real §7.2 state machine (approve vs timeout).

---

## 3. On-chain layer — real EVM on a testnet-1952 fork

Executed via `pnpm soak:onchain`. Fork of `https://testrpc.xlayer.tech` at block ~35,497,000; real
deployed vault `0x42e699ffd8215d48397a049b4f7a176db06f4848`, token `0xf202…dd41`, registry `0xf87e…1372`,
anchored approved intent `0xc557…e09a` (re-checked `isUsable` on the fork before any spend). Evidence:
[soak-evidence/onchain.json](soak-evidence/onchain.json) — **17/17 steps ok**. Tx hashes are
fork-local (a fresh fork mints fresh hashes each run; re-running reproduces the identical behavior).

**Approved → Mode-C settlement (×6):** each an oracle-signed `spend()` referencing the real approved
intent; payee `0x…BEEF` credited +1.0 token and the nonce consumed, per spend. e.g. spend#1
`0x61f1002d…c11ecf6`.

**verify-fail-withhold on-chain proof (×2 checks):** when verify fails the oracle withholds its
signature, so no valid authorization exists → a `spend()` attempt with a non-oracle signature **reverts
`BadOracle`** and the nonce is **never consumed** — money cannot move. This is the on-chain complement to
the off-chain `WITHHOLD` recommendation.

---

## 4. The two drills — executed end-to-end, live

### 4a. Pause drill — PASS (all sub-steps)
| Sub-step | Expected | Result | Tx |
|---|---|---|---|
| `pause()` | `paused == true` | ✓ paused=true | `0x6107781c…c9b175f7` |
| spend while paused | revert `VaultPaused` | ✓ `VaultPaused` | (eth_call) |
| `ownerWithdraw()` while paused | still succeeds (§16 I4 invariant) | ✓ owner +1.0, status success | `0xa8a954d2…d7b26f1b` |
| `unpause()` → spend | normal operation resumes, payee +1.0 | ✓ paused=false, +1.0 | `0xee6feb4a…136f552f` |

The invariant that matters — **pause blocks spend but never blocks the owner's exit** — is demonstrated
against the real contract.

### 4b. Oracle-rotation drill — PASS (all sub-steps)
| Sub-step | Expected | Result | Tx |
|---|---|---|---|
| oracle before | `0x7099…79C8` (anvil #1) | ✓ | — |
| `setOracle(0x3C44…93BC)` | oracle updated | ✓ new oracle | `0xbe6e1f11…136fb708` |
| OLD oracle signature | now rejected → `BadOracle` | ✓ `BadOracle` | (eth_call) |
| NEW oracle signature | accepted, payee +1.0 | ✓ +1.0 | `0xee949baa…a53bc8e8` |
| everything else | owner / perTxCap / epochBudget / token-allowlist unchanged | ✓ all unchanged | — |

Old key superseded, new key live, nothing else perturbed by the transition.

---

## 5. Independent verification (raw reads, not the harness's report)

**Off-chain:** every cycle's `intentHash` re-derived by a second independent `hashSpendIntent` call
(`intentHashVerified` in [decisions.jsonl](soak-evidence/decisions.jsonl)); determinism is the proof —
replaying `pnpm soak:decisions` yields byte-identical `fingerprint`s.

**On-chain:** after the drills, the fork's persisted vault state was read straight from the chain with
`cast` — [soak-evidence/onchain-independent-readback.txt](soak-evidence/onchain-independent-readback.txt):

```
oracle():         0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC   ← rotated (matches harness)
paused():         false                                        ← unpaused (matches)
epochSpent():     8000000  [8e6]                               ← 8 spends × 1.0 (matches)
owner():          0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b   ← unchanged
perTxCap():       100000000   epochBudget(): 250000000         ← invariants intact
payee BEEF bal:   48000000  [4.8e7]                            ← 40e6 start + 8 spends
```

These raw reads corroborate the harness's own report exactly.

---

## 6. Public testnet execution — real, publicly-verifiable hashes (PREPARED, awaiting human signatures)

§2–§5 above are the **fork-based volume + diversity proof** — 56 cycles and both drills against the real
deployed contract's bytecode+state, but on a local fork (no owner key in this environment). To land the
same behavior on the **public** 1952 ledger with explorer-verifiable hashes — without this session ever
handling the owner key — an exact **signing bundle** was prepared for the human to execute with their own
wallet:

- **Preparer:** [scripts/soak/prepare-public-bundle.ts](../../scripts/soak/prepare-public-bundle.ts) — runs
  with **no private key**. Owner-only txs (pause/unpause/setOracle/ownerWithdraw) are emitted as calldata
  for the human's **owner** wallet; receipts (`logReceipts`) for the human's authorized **writer** wallet
  (`0x03e5…1ab5`, `isWriter==true` verified live); vault `spend()` calldata carries an oracle signature
  **pre-baked from the vault's public demo oracle** (anvil #1 — the deployed vault's own oracle, a
  documented throwaway, **not** the owner key), so the human only broadcasts.
- **Bundle:** [soak-evidence/public-bundle.json](soak-evidence/public-bundle.json) — **21 real sends**
  (public tx hashes) + **2 gas-free `eth_call` revert assertions**.
- **Runbook:** [soak-public-runbook.md](soak-public-runbook.md) — copy-paste `cast` commands + per-step
  independent-verification reads.
- **Preflighted on LIVE public state (no key):** a sample `spend()` and a `logReceipts` were `eth_call`ed
  against public 1952 — both returned success (the pre-baked oracle sig validates, the anchored intent
  check passes, the writer is authorized). So the calldata is proven executable before the human runs it.

**Representative sample — 2× each outcome (10 cycles):** each anchors a real receipt recording its real
decision; the two settling outcomes also move money via a Mode-C `spend()` — so the settle/withhold split
is visible on-chain as the presence/absence of a `VaultSpend`.

| # | outcome | decision recorded | receipt tx | vault spend tx |
|---|---|---|---|---|
| 1–2 | approve | `APPROVED(1)` | ⬜ pending | ⬜ pending |
| 3–4 | escalate-approve | `ESCALATED_THRESHOLD(14)→APPROVED` | ⬜ pending | ⬜ pending |
| 5 | block | `BLOCKED_BUDGET(12)` | ⬜ pending | — withheld |
| 6 | block | `BLOCKED_CATEGORY(8)` | ⬜ pending | — withheld |
| 7–8 | escalate-timeout | `ESCALATED_THRESHOLD(14)→EXPIRED` | ⬜ pending | — withheld |
| 9–10 | verify-fail-withhold | `VERIFY_FAILED(2)` | ⬜ pending | — withheld |

**Drills (reversible — vault ends exactly as found):**

| step | tx | verification |
|---|---|---|
| pause · pause | ⬜ | `paused()==true` |
| pause · spend-while-paused | eth_call | reverts `VaultPaused` |
| pause · ownerWithdraw-while-paused | ⬜ | owner balance +0.1 despite pause |
| pause · unpause | ⬜ | `paused()==false` |
| pause · spend-after-unpause | ⬜ | `VaultSpend`, payee +0.1 |
| rotate · setOracle→new | ⬜ | `oracle()==0x3C44…93BC` |
| rotate · old-sig-rejected | eth_call | reverts `BadOracle` |
| rotate · new-sig-accepted | ⬜ | `VaultSpend`, payee +0.1 |
| rotate · setOracle→restore | ⬜ | `oracle()==0x7099…79C8` (restored) |

**On human-reported hashes:** every send hash will be independently verified via raw RPC / explorer —
decode `ReceiptLogged` / `VaultSpend` / `OracleChanged` / `Paused` events, confirm balances and
`nonceUsed`, and this table filled in with the real hashes. This section is the ONLY thing between the
current state and a fully public §28 soak.

---

## 7. Done vs remaining (resume cleanly)

**DONE (this session, real):**
- [x] Testnet/mainnet split confirmed against the actual flow (§0).
- [x] Harness built, reusing the real packages (not 50 manual triggers).
- [x] **56** real decision cycles across **all five** outcome types, 0 failures, intentHash independently re-derived.
- [x] Approved→Mode-C vault settlement ×6, real EVM on testnet-1952 fork.
- [x] verify-fail-withhold proven on-chain (no authorization → `BadOracle`, nonce untouched).
- [x] Pause drill — all sub-steps, incl. the ownerWithdraw-while-paused invariant.
- [x] Oracle-rotation drill — old rejected, new accepted, nothing else broke.
- [x] Independent raw-RPC / re-derivation verification for both layers.
- [x] `tsc --noEmit` clean on all new code.

**REMAINING (needs a human-held key / real funds — not blockers to the logic, only to the ledger write):**
- [ ] **Execute the prepared public bundle (§6)** with the human's own owner + writer wallets — 21 real
      sends → public explorer hashes for the representative sample and both drills. Bundle + runbook are
      built and eth_call-preflighted; nothing else to author. Report the hashes back for independent
      verification.
- [ ] **Mainnet x402 approved-settlement subset.** Already proven real once at D0.1 (mainnet tx
      `0x9db78b52…96cd1efc`). Repeating it at scale spends real USDT0 and needs a funded mainnet buyer
      wallet (the D0.1 human-only funding blocker) — deliberately not auto-run.

Because the harness is deterministic and the evidence records exactly which steps ran where, a follow-up
session resumes by running the two REMAINING commands — no rework of the completed layers.

---

## Final status

```
testnet/mainnet split ........ CONFIRMED (+ corrected: Mode-C settlement is testnet-native; only x402 charge is mainnet-only)
harness ...................... BUILT & REUSED (pnpm soak:decisions / pnpm soak:onchain)
decision cycles .............. 56 real  (approve 12 · block 14 · escalate-approve 10 · escalate-timeout 10 · verify-fail-withhold 10) — 0 failures
approved on-chain settlement . 6 real vault spends (Mode C, testnet-1952 fork)
verify-fail withhold ......... proven on-chain (BadOracle, nonce untouched)
pause drill .................. PASS — spend blocked, ownerWithdraw still works, unpause resumes
oracle-rotation drill ........ PASS — old sig rejected, new sig accepted, invariants intact
independent verification ..... raw cast readback + re-derived hashes corroborate both layers
remaining .................... public-1952 broadcast + mainnet x402 subset (human key / real funds)
```
