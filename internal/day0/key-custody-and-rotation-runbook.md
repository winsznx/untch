# Untch — Key custody & rotation runbook

**Satisfies:** PRD §28 mainnet checklist — *"admin/oracle/writer keys documented with rotation runbook
tested."* This is that document. Every rotation mechanism below was **executed for real on X Layer
testnet 1952** and independently verified; the tx hashes are cited inline. Where a role has **no**
rotation mechanism, this says so plainly rather than implying one.

**Date:** 2026-07-13 · **Networks:** X Layer mainnet 196 / testnet 1952 · **Tooling:** `cast` (Foundry),
hardware wallet (Ledger/Trezor) or an MPC/HSM signer.

---

## 0. Why this document exists — the incident it closes

The original demo `UntchVault` (`0x42e6…4848`) is **permanently owner-locked**: its owner/admin key
(`0x98F4…3c0b`, the "ops wallet" — deployer + vault owner + `UntchReceipts` admin) **was not retained**.
Every `onlyOwner` function on that vault (`pause`, `setOracle`, `ownerWithdraw`, `transferOwnership`) can
never be called again. Nothing of value was lost (the vault holds 0 OKB and only a valueless `MockERC20`),
but the *capability* is gone forever.

The key was **persistent by design** — funded on mainnet and testnet, sovereign across the whole contract
suite — and the repo deliberately never stored it (`BLOCKERS.md`: *"custody the private key yourself —
never put it in this repo"*). It was supposed to be saved out-of-band and wasn't. A local `.env` file is
**not durable storage**: it is per-machine, un-backed-up, and silently lost on reinstall/loss. That is the
exact failure mode this runbook exists to prevent.

**The one lesson, stated once, applied everywhere below:** for any key whose loss is irreversible — above
all the **vault owner** — **rotate proactively at the first sign of doubt** about the key's durability
(machine change, unclear backup, staffing change, suspected exposure), *while the current key can still
authorize the move*. For the vault owner that means running `transferOwnership` → `acceptOwnership` to a
freshly-custodied key **before** the old one is in question. A two-step transfer done a week early costs a
few cents of gas; skipped, it costs the contract.

---

## 1. Roles at a glance

| Role | Contract(s) | Powers | Rotation mechanism | Rotation is… |
|---|---|---|---|---|
| **owner** | `UntchVault` | pause/unpause, setOracle, ownerWithdraw, set fallback allowlist | `transferOwnership` → `acceptOwnership` (two-step) | ✅ exists — **two-step, self-authorized** |
| **oracle** | `UntchVault` | signs `Spend` EIP-712 digests (authorizes spends) | owner calls `setOracle(new)` | ✅ exists — one-step, owner-gated |
| **writer** | `UntchReceipts` (+ `SpendIntentRegistry`) | writes into the append-only log; **holds no funds, moves no money** | admin `propose`→wait→`execute` ADD/REMOVE_WRITER (timelocked) | ✅ exists — **timelocked** (Receipts); immediate (SIR) |
| **admin** | `UntchReceipts` (+ `SpendIntentRegistry`) | manages the writer set + transfers admin | admin `propose`→wait→`execute` TRANSFER_ADMIN (timelocked) | ✅ exists — **timelocked, single-step** (Receipts); immediate (SIR) |

There is **no on-chain rotation for the x402 buyer/settlement key** or any off-chain signing key — those
are plain EOAs with no contract role; "rotation" there means generating a new wallet and repointing config
(see §6).

---

## 2. Owner (UntchVault) — the critical one

### Generate
- **Hardware-backed, always.** A Ledger/Trezor, or an MPC/HSM signer for a team. The owner is the fund
  sovereign and the only key that can ever pause the vault or move funds via `ownerWithdraw`; it must never
  exist as a raw hex string on a laptop.
- Derive a dedicated address used **only** as the vault owner (don't reuse the deployer-of-everything
  pattern that created this incident — see §5 on least privilege).

### Store durably (not a lone `.env`)
- The signing key stays **on the hardware device**; only its **public address** goes in config
  (`OPS_WALLET_ADDRESS` / a deploy manifest).
- Back up the device's **recovery seed** to at least two physically-separate, offline locations (steel
  plate / paper in a safe). For a team: an MPC quorum (e.g. 2-of-3) so no single lost device is fatal.
- Record the address, its role, and where the seed is custodied in an ops registry **outside the repo**.
  Never the private key or seed in the repo, a chat, or a screenshot.

### Rotate — `transferOwnership` → `acceptOwnership` (two-step, tested)
The vault uses a **two-step** transfer: the old owner nominates, the new owner accepts. Ownership only
moves when the **new** key proves control by sending `acceptOwnership` — so a fat-fingered address cannot
brick the vault, and the transfer is atomic from the old key's side.

```bash
export RPC=https://testrpc.xlayer.tech        # or mainnet https://rpc.xlayer.tech
VAULT=0x…                                      # the vault to rotate
NEW_OWNER=0x…                                  # freshly-custodied hardware address

# 1) OLD owner nominates (must run while the old key still works — this is the proactive-rotation step)
cast send $VAULT 'transferOwnership(address)' $NEW_OWNER --private-key <OLD_OWNER or --ledger> --rpc-url $RPC
#    owner() is UNCHANGED here; pendingOwner() == NEW_OWNER

# 2) NEW owner accepts (proves control of the new key)
cast send $VAULT 'acceptOwnership()' --private-key <NEW_OWNER or --ledger> --rpc-url $RPC
#    owner() == NEW_OWNER; pendingOwner() == 0

# verify
cast call $VAULT 'owner()(address)' --rpc-url $RPC
cast call $VAULT 'pendingOwner()(address)' --rpc-url $RPC   # 0x0 after accept
```

**Tested live on testnet 1952** (fresh vault `0xd1328df7f36407a3c56102bb8c2208845515910a`, owner = writer
wallet `0x03e5…1ab5`, new owner K2 = `0x90F7…b906`):

| step | proof |
|---|---|
| `transferOwnership` (old key) — `pendingOwner`=K2, `owner` still old | `0xd940dcfe15e50f8ca89c5cb8ab6374bdfd5cb9ef1ef83bb596a33575abcce5d4` |
| accept by a **non-pending** account reverts `NotPendingOwner` | eth_call (verified) |
| `acceptOwnership` (new key) — `owner`=K2, `pendingOwner`=0 | `0x9225c1baa3562d966df1ac28be97d2800008bf14354a73537fa210838a35e7ca` |
| round-trip back (nominate + accept) — `owner` restored | `0x0389435c2a826dbd84986bd85d2a330da5b9d36171bbabbfebcc7a5faf500ef7` |

**Failure mode to internalize:** step 1 needs the *old* key. If the old key is already lost, there is **no
recovery** — the vault is owner-locked, exactly as `0x42e6…4848` now is. Rotate before that happens.

> There is **no `renounceOwnership`** and no zero-address owner path — deliberately, so ownership can't be
> accidentally destroyed. The only exit is transfer-to-a-new-key.

---

## 3. Oracle (UntchVault) — one-step, owner-gated

### Generate & store
- The oracle **signs `Spend` digests** (`EIP-712`, `domain{name:"UntchVault",chainId,verifyingContract}`).
  It authorizes money movement, so treat it as high-value: hardware or HSM/TEE signer (the SKILL/PRD notes
  "TEE or local-key sign"). It holds **no funds** itself.
- Store as in §2. The demo used a well-known throwaway (anvil #1) *on purpose* — never do that in prod.

### Rotate — `setOracle` (tested)
Immediate, owner-only. Rotate on suspected oracle-key exposure, or as scheduled hygiene. Old signatures are
rejected the instant the new oracle is set.

```bash
cast send $VAULT 'setOracle(address)' $NEW_ORACLE --private-key <OWNER or --ledger> --rpc-url $RPC
cast call $VAULT 'oracle()(address)' --rpc-url $RPC   # == NEW_ORACLE
```

**Tested live on testnet 1952** (same fresh vault): rotate → new
`0x1725172b8865ed9263a0f5a5694008c56b4b5786fe784b0aec428229dbdca7e8`, restore
`0x530c96febd2190551370b9edbf3bfea7402cfc808c82ac82b93a97600d8b641f`. Additionally proven in the §28 soak
drills: after `setOracle`, an **old-oracle signature reverts `BadOracle`** and a new one is accepted
([soak-test-results.md §6b](soak-test-results.md)).

**Continuity note:** rotating the oracle invalidates any in-flight `Spend` signatures the old oracle
produced. Drain/settle or re-sign pending spends around a rotation. Because `setOracle` is one-step, double-
check the new address — there is no accept handshake to catch a typo (a wrong oracle can be corrected by the
owner, but only the owner, so don't lose that too).

---

## 4. Writer (UntchReceipts) — timelocked

### Generate & store
- The writer **only writes into the append-only log** — it holds no funds and authorizes no transfer (§16:
  "writer signs only into event log"). It runs headless on a server (the anchoring worker), so it is the
  one role that legitimately lives as an environment secret — but even then in a **secrets manager**
  (Railway variables / Vault / KMS), never a committed file, and it is a **burner** funded only with gas.
- Because it's low-privilege and hot, prefer **frequent, cheap rotation** over heavy custody.

### Rotate — timelocked `propose` → wait → `execute` (tested)
`UntchReceipts` routes writer-set changes through a **timelock** (spec: "admin behind timelock"): the admin
proposes, waits `timelockDelay`, then executes. Early execution reverts; a pending op can be `cancel`led
inside the window. `OpKind`: `1=ADD_WRITER, 2=REMOVE_WRITER, 3=TRANSFER_ADMIN`.

```bash
RECEIPTS=0x…
NEW_WRITER=0x…
# add the new writer
cast send $RECEIPTS 'propose(uint8,address)' 1 $NEW_WRITER --private-key <ADMIN> --rpc-url $RPC
#   … wait timelockDelay seconds (cast call $RECEIPTS 'timelockDelay()(uint64)') …
cast send $RECEIPTS 'execute(uint8,address)' 1 $NEW_WRITER --private-key <ADMIN> --rpc-url $RPC
cast call $RECEIPTS 'isWriter(address)(bool)' $NEW_WRITER --rpc-url $RPC   # true
# remove the old writer (same two-phase flow, kind = 2)
cast send $RECEIPTS 'propose(uint8,address)' 2 $OLD_WRITER --private-key <ADMIN> --rpc-url $RPC
#   … wait timelockDelay …
cast send $RECEIPTS 'execute(uint8,address)' 2 $OLD_WRITER --private-key <ADMIN> --rpc-url $RPC
# to abort a pending op inside the window:  cast send $RECEIPTS 'cancel(uint8,address)' <kind> <target> …
```

**Tested live on testnet 1952** (fresh `UntchReceipts` `0xaaaf54edadcb18468c00684a1e1619374d94ef1e`,
`timelockDelay`=60s, admin = writer wallet, target K3 = `0x15d3…6A65`):

| step | proof |
|---|---|
| `propose(ADD_WRITER, K3)` | `0xed86b933405e42c011032b1a2625dbb38d6a6c95cc6ba2c085da7121ff121c78` |
| `execute` **before** delay reverts `TimelockNotElapsed` | eth_call (verified) |
| `execute(ADD_WRITER)` after 60s → `isWriter(K3)=true` | `0xabebf5f7379edcf63fd6ef4d1037b757589d9fe9e391bc3bd23e7c26a265d22d` |
| `execute(REMOVE_WRITER)` after 60s → `isWriter(K3)=false` | `0x3ce3a3b7674ff0f699d810cb3fc856354336671e67f82dad79af7cfb5a97a781` |

(The zero-downtime pattern: **add the new writer, cut traffic over, then remove the old** — never remove
before the replacement is live.) `SpendIntentRegistry` exposes the same operations as **immediate**
`onlyAdmin` externals `addWriter(address)` / `removeWriter(address)` — no timelock, by its documented
first-pass design.

---

## 5. Admin (UntchReceipts / SpendIntentRegistry) — timelocked, single-step

### Powers & custody
- The admin manages the writer set and can transfer admin. It is **separate from `writer`** by design
  (least privilege) and is **not itself a writer**. Custody it like the owner (§2): hardware/MPC, seed
  backed up offline, out-of-repo registry. In this incident the admin was the *same* key as the vault owner
  — see the least-privilege note below.

### Rotate — timelocked `TRANSFER_ADMIN` (tested)
```bash
cast send $RECEIPTS 'propose(uint8,address)' 3 $NEW_ADMIN --private-key <ADMIN> --rpc-url $RPC
#   … wait timelockDelay …  (cancel with kind=3 inside the window if wrong)
cast send $RECEIPTS 'execute(uint8,address)' 3 $NEW_ADMIN --private-key <ADMIN> --rpc-url $RPC
cast call $RECEIPTS 'admin()(address)' --rpc-url $RPC   # == NEW_ADMIN
```

**Tested live on testnet 1952** (same fresh Receipts, new admin K2 = `0x90F7…b906`):
`execute(TRANSFER_ADMIN)` after 60s → `admin=K2`, tx
`0x204586e7410c6b3bd3b93f99b3eae8c5c5da7e24fc1a74e80e01fe64fc0b13b4`.

**⚠ Admin transfer is single-step** (no `acceptAdmin` handshake) — unlike the vault owner. A wrong
`NEW_ADMIN` on `UntchReceipts` is only survivable because the timelock gives a `cancel` window before
`execute`; on `SpendIntentRegistry` the immediate `transferAdmin(address)` has **no** window, so an
address typo there **permanently bricks writer-set management**. Triple-check the address, and prefer
transferring to a hardware address you have already proven you can sign from (send it a dust tx first).

**Least-privilege lesson from this incident:** one key was deployer **and** vault owner **and** receipts
admin. That concentration is why a single loss was maximally damaging. Going forward, separate them: a
deployer key (can be rotated out entirely post-deploy), a vault owner (hardware), an oracle (HSM/TEE), a
receipts admin (hardware), and a hot writer (secrets-manager burner). Losing any one should never be
unrecoverable.

---

## 6. Keys with NO on-chain rotation — stated plainly

- **x402 buyer / settlement key** (`XLAYER_SETTLEMENT_PRIVATE_KEY` / the D0.1 buyer) — a plain EOA that
  signs EIP-3009 transfers; it has **no contract role and no rotation mechanism**. "Rotating" it means
  generating a new funded wallet and repointing config/secrets; there is nothing on-chain to update.
- **Deployer key** — has no *ongoing* role; after deploy it is only the initial owner/admin, which you
  should **transfer away** per §2/§5. There is no "deployer rotation" — you simply stop using it.
- **OKX API HMAC triple** (`OKX_API_KEY/SECRET/PASSPHRASE`) — rotated in the OKX dashboard, not on-chain;
  out of scope here beyond: store in a secrets manager, never the repo.

---

## 7. Standing procedure (the checklist to actually follow)

1. **Never** put a private key or seed in the repo, `.env`, chat, or a screenshot. Config holds **public
   addresses only**.
2. Every role key is **hardware/MPC/HSM** except the hot writer (secrets-manager burner).
3. Seeds backed up to **≥2 offline, physically-separate** locations; team keys behind an **MPC quorum**.
4. Maintain an **out-of-repo key registry**: role → address → device/custodian → seed-backup location.
5. **Separate the roles** (deployer ≠ owner ≠ oracle ≠ admin ≠ writer). Transfer the deployer out after
   deploy. Enforce this mechanically, not by eye:
   - **pre-deploy:** `pnpm verify:role-separation` — asserts all ten pairwise inequalities across the five
     PUBLIC addresses, fails loudly (exit 1) if any two match. Public addresses only, no keys.
     ([scripts/soak/verify-role-separation.ts](../../scripts/soak/verify-role-separation.ts))
   - **post-deploy:** `pnpm verify:deployment-roles` — reads each contract's ACTUAL on-chain
     owner/oracle/admin/writer-set and asserts they equal the intended addresses exactly, incl. that the
     deployer holds no live role and `pendingOwner==0`. Read-only; gate CI on its exit code.
     ([scripts/soak/verify-deployment-roles.ts](../../scripts/soak/verify-deployment-roles.ts))
6. **Rotate proactively at the first doubt** about durability — especially the vault owner, via
   `transferOwnership`/`acceptOwnership`, **while the old key still signs**. Do not wait for certainty of
   loss; by then it is too late.
7. Before a mainnet deploy, dry-run each rotation on testnet (this document's scripts:
   [scripts/soak/test-key-rotations.ts](../../scripts/soak/test-key-rotations.ts)) and re-file the fresh
   evidence here.

---

## Appendix — evidence index

- Rotation test runner: [scripts/soak/test-key-rotations.ts](../../scripts/soak/test-key-rotations.ts)
- Raw results (all hashes + checks): [soak-evidence/key-rotation-tests.json](soak-evidence/key-rotation-tests.json)
- Related soak proof (oracle rotation + pause under load): [soak-test-results.md](soak-test-results.md)
- Fresh instances used: vault `0xd1328df7f36407a3c56102bb8c2208845515910a`, receipts
  `0xaaaf54edadcb18468c00684a1e1619374d94ef1e` (X Layer testnet 1952) — owned/admin'd by the writer wallet
  `0x03e5…1ab5`, because the original demo instances' owner/admin key is the one this incident lost. The
  lost key was never handled.
```
