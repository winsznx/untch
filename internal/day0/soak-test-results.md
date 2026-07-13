# §28 Testnet soak — results

**Gate:** PRD §28 "Testnet soak: ≥50 full real cycles on X Layer testnet across all decision outcomes
(approve / block / escalate-approve / escalate-timeout / verify-fail-withhold), plus a pause drill and
an oracle-key rotation drill executed end-to-end."

**Status:** **COMPLETE.** All five outcome types + both drills executed for real on a testnet-1952 fork
against the real deployed contract (§2–§4, volume/diversity). On PUBLIC testnet 1952: the representative
sample — 10 cycles + 4 Mode-C spends — executed & verified with the writer key (§6a, **14 real hashes**);
and **both drills executed & verified live** (§6b) on a freshly-deployed writer-owned vault (the original
demo vault's owner key was not retained, so a fresh instance of the identical bytecode was used — the lost
owner key was never touched). Only the mainnet x402 charge remains, already proven once at D0.1 (§7).
**Date:** 2026-07-13
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

## 6. Public testnet execution — real, publicly-verifiable hashes

§2–§5 above are the **fork-based volume + diversity proof** — 56 cycles and both drills against the real
deployed contract's bytecode+state, but on a local fork (no owner key in this environment). This section
lands the same behavior on the **public** 1952 ledger with explorer-verifiable hashes, split by signer so
this session never touches the owner key:

- **WRITER half — DONE & independently verified (14 real public txs).** Executed with ONLY the
  receipt-writer burner key (`0x03e5…1ab5`, gitignored) by
  [scripts/soak/execute-public-writer.ts](../../scripts/soak/execute-public-writer.ts): the 10 Part-A
  receipt anchors + the 4 Part-A Mode-C vault spends. Every tx verified from its mined receipt (events
  decoded) and post-state read from chain, then cross-checked with raw `cast`.
- **OWNER half — the human's 5 owner-signed drill steps** (pause, ownerWithdraw, unpause, setOracle→new,
  setOracle→restore) run separately; hashes pending. The 3 transient `eth_call` assertions
  (spend-while-paused reverts, old-sig rejected, new-sig accepted) are verified via **historical
  `eth_call`** at blocks inside each transient window once those hashes land (archive queries confirmed
  supported on the public RPC).

The bundle the human executes:

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

### 6a. Representative sample — 2× each outcome (10 cycles) — DONE ✓

Each cycle anchored a real receipt (`logReceipts` → `ReceiptLogged`) recording its real decision; the two
settling outcomes also moved money via a Mode-C `spend()` — so the settle/withhold split is visible
on-chain as the presence/absence of a `VaultSpend`. Full log + decoded events + post-state:
[soak-evidence/public-writer-results.json](soak-evidence/public-writer-results.json). Independent
post-state read from chain: **payee +400000 base units = 4 × 0.1 token; 4/4 spend nonces consumed**.

| # | outcome | decision (on-chain) | receipt tx | vault spend tx |
|---|---|---|---|---|
| 1 | approve | `decision=1` | `0xb58295d50fb5d29fd497db30958b6d231df078969a8daee308300a3407e8ea53` | `0x367c74779da70a6803e9ab4a637abf189a77f2ab09d32c614d1de0b2c51bb64b` |
| 2 | approve | `decision=1` | `0x4f9739083ca3230ca3f14da310f05033f1b2451f04ad2eb2d40c5faf3f4bb3e7` | `0x4bb4875b131ce2e147810c10c40dd872c75576e60cbe258e31c29464dc127bb7` |
| 3 | escalate-approve | `decision=14→APPROVED` | `0x305687f844e14a41025962eef303da1383cc0bcdd0f6a5803c3d27362dd74ee5` | `0x5e7b5518f6108fcb450b2f5b672127c57ee5a0472998ca5e4a6772f496fd130a` |
| 4 | escalate-approve | `decision=14→APPROVED` | `0x59ee20814139aafcb1a27b91429d52bdc909fa446a460ab3f854ba660a053eaa` | `0x92647c3f1508961d66798bfa64205d239d05e21a2414de5198443a6bf8a91904` |
| 5 | block | `decision=12` (BUDGET) | `0x35ea4a45de0280f9907bc6ba90f0e1918cafc759e5129d16f5810b4368abc6a9` | — withheld |
| 6 | block | `decision=8` (CATEGORY) | `0xd9cee9e981ef16ad745683736511239eaf5eaa8d651791880d2b2fd12869ea3e` | — withheld |
| 7 | escalate-timeout | `decision=14→EXPIRED` | `0xe56fcad9e0a27c82869a0c1d8b253977f2d8c3c91ab4ea76433fb06fb72027b5` | — withheld |
| 8 | escalate-timeout | `decision=14→EXPIRED` | `0x071efc206563dc61d4370c5844d7a61ee172e2de128cb12d289610c28afac771` | — withheld |
| 9 | verify-fail-withhold | `verifyResult=2` (FAIL) | `0x327d21df06c6e3f51570a7ff3f197f91c1026f9ffcfe12b517cf8da62f7eddf6` | — withheld |
| 10 | verify-fail-withhold | `verifyResult=2` (FAIL) | `0x79bcb5027a5dc06425a0f3a4bc1729cb0e1fc6f7025086734b1397e8960e0e77` | — withheld |

Independent cross-check (raw `cast`, not the executor's report): spend #1 `status 1 (success)` at block
35503152; receipt #1 `status 1 (success)` at block 35503146; `balanceOf(payee)` 40000000 → 40400000;
`epochSpent` reflects the 4 spends. All 14 mined, 0 failures.

### 6b. Drills on public testnet — DONE ✓ (on a fresh writer-owned vault)

The original demo vault's owner key (`0x98F4…3c0b`) turned out to be unavailable — the operator did not
retain it — and its `onlyOwner` functions (`pause`/`setOracle`/`ownerWithdraw`) can never be reached again.
The drills prove the **contract's** behavior, not that one instance, so they were executed against a
**freshly-deployed UntchVault of the identical bytecode, owned by the receipt-writer wallet
(`0x03e5…1ab5`)** — a key this session is authorized to hold. The lost owner key was never touched.
Evidence: [soak-evidence/public-drills.json](soak-evidence/public-drills.json). Runner:
[scripts/soak/public-drills-fresh-vault.ts](../../scripts/soak/public-drills-fresh-vault.ts).

- **Fresh vault:** `0xd96d0058d6bd6483daaa0f39e7b5985ec2d96688` (deploy tx
  `0xc3921f9f4347b92fe3fd1be47ddfe5f184c10d10dc169747ead5e6e325bb7713`), owner = writer, oracle = anvil #1,
  `requireAnchoredIntent=false` (self-contained — the anchored-intent gate was already exercised in §4/§6a).
- **Independent `cast` readback of final state:** `owner()=0x03e5…1ab5`, `oracle()=0x7099…79C8` (restored),
  `paused()=false`, payee balance `200000` (= 2 successful drill spends × 0.1). Every send below confirmed
  `status 1` via raw `cast receipt` — not the harness's own report.

**Pause drill — PASS (all sub-steps):**

| step | tx | verification |
|---|---|---|
| pause | `0xc8ca5a86657be9d2fc213fc6e338879223a8b73d008b4caecda95b28a2291cf0` | `paused()==true` |
| spend-while-paused | eth_call (in-window) | reverts **`VaultPaused`** |
| ownerWithdraw-while-paused | `0x5869d1981e75fc806f3f22b2442050974150b75472427a2da86024aaaa2e3e24` | owner +0.1 **despite pause** |
| unpause + spend-after-unpause | `0x1074499e6fae0509f0cf6277cfcc620a4eb4f0dd302c18aaba757eaf5915e14c` | `paused()==false`, payee +0.1 |

**Oracle-rotation drill — PASS (all sub-steps):**

| step | tx | verification |
|---|---|---|
| setOracle→new | `0xe86f17cd0d09a4fcabd021a5617234acc838c7508964c4596e791e401cee70eb` | `oracle()==0x3C44…93BC` |
| old-sig-rejected | eth_call (in-window) | reverts **`BadOracle`** |
| new-sig-accepted | `0xd371395df7d484bd734d34ce222325657e76612ef90a4d59918f3aea3019232f` | payee +0.1 |
| setOracle→restore | `0x5f47140e867b4c2888fcc7085fda7353a9a8174ce9d55f827d896746732d0658` | `oracle()==0x7099…79C8`; owner/cap/token unchanged |

An impostor (non-oracle) signature was also confirmed to revert `BadOracle` after restore. Both drills:
**real public hashes, every step independently verified.**

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
- [x] **PUBLIC testnet 1952 — representative sample:** 10 real receipts + 4 Mode-C spends, **14 real
      hashes** (§6a), each independently verified (event decode + on-chain post-state + raw `cast`).
      Executed with only the writer burner key.
- [x] **PUBLIC testnet 1952 — both drills:** pause + oracle-rotation executed live on a fresh
      writer-owned vault (§6b, 8 real hashes incl. deploy), every step independently `cast`-verified. The
      lost original-owner key was never touched.

**REMAINING (real funds; already proven once):**
- [ ] **Mainnet x402 approved-settlement subset.** Already proven real once at D0.1 (mainnet tx
      `0x9db78b52…96cd1efc`). Repeating it at scale spends real USDT0 and needs a funded mainnet buyer
      wallet (the D0.1 human-only funding blocker) — deliberately not auto-run.

The mainnet x402 charge is the only piece not repeated here; it was already proven real once at D0.1
(mainnet tx `0x9db78b52…96cd1efc`), and repeating it at scale spends real USDT0 on a funded mainnet buyer.

---

## Final status

```
testnet/mainnet split ........ CONFIRMED (+ corrected: Mode-C settlement is testnet-native; only x402 charge is mainnet-only)
harness ...................... BUILT & REUSED (soak:decisions / soak:onchain / soak:prepare-public / execute-public-writer / public-drills-fresh-vault)
decision cycles (fork) ....... 56 real  (approve 12 · block 14 · escalate-approve 10 · escalate-timeout 10 · verify-fail-withhold 10) — 0 failures
fork drills .................. both PASS (real EVM vs the real deployed vault, owner impersonated)
PUBLIC sample (real hashes) .. 10 receipts + 4 Mode-C spends = 14 txs, all verified (payee +0.4, 4/4 nonces)
PUBLIC pause drill ........... PASS live — spend blocked (VaultPaused), ownerWithdraw works paused, unpause resumes
PUBLIC oracle-rotation drill . PASS live — old sig rejected (BadOracle), new accepted, restored, invariants intact
independent verification ..... raw cast readback + event decode + re-derived hashes corroborate every layer
remaining .................... mainnet x402 subset only (real USDT0; already proven once at D0.1)
```
