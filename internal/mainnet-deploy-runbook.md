# Mainnet deployment runbook — four base contracts, X Layer (196)

Everything below was verified against a fork of real X Layer mainnet on 2026-07-14. Nothing has been
broadcast. The only person who ever touches the deployer private key is you, in your own terminal.

---

## 1. FINDING: UntchReceipts cannot bootstrap a writer. There is a real 72-hour dead period.

**Confirm you are fine with this before running anything.**

The constructor takes one argument, the delay — there is no initial-writer parameter:

```solidity
constructor(uint64 delay) {            // UntchReceipts.sol:233
    if (delay == 0) revert ZeroDelay();
    timelockDelay = delay;
}
```

The base constructor sets `admin = msg.sender` and nothing else. This is deliberate, and documented at
`AuthorizedWriters.sol:88`:

> There is deliberately no initial-writer constructor arg — the writer set is always established
> through the audited add-writer path (immediate in §10.2, timelocked in §10.3).

`execute` (UntchReceipts.sol:339) is the **only** path that reaches `_addWriter`, and it hard-enforces
`block.timestamp >= eta`. There is no bypass — not for the admin, not for the deployer.

I proved this on a mainnet fork rather than trusting the source read. With `timelockDelay = 259200` (72h):

| Time | Action | Result |
|---|---|---|
| T+0 | `logReceipts` / `anchorScore` / `anchorAudit` as deployer+admin | **all revert** (`NotWriter`) |
| T+0 | `execute(ADD_WRITER)` right after `propose` | **reverts** (`TimelockNotElapsed`) |
| T+71h59m | `execute(ADD_WRITER)` | **reverts** |
| T+72h00m | `execute(ADD_WRITER)` | succeeds → `isWriter[writer] = true` |

**What this means in practice.** For 72 hours after deployment, UntchReceipts accepts no writes from
anyone: no receipt log, no score anchoring, no audit anchoring. The other three contracts are **fully
live at T+0** — PolicyRegistry is permissionless (no roles at all), SpendIntentRegistry's admin is
immediate so its writer is authorized in the same session, and the Factory has no roles. So policies
register, intents anchor, and vaults deploy from minute one; only the receipt log is dark.

The dead period is recoverable, not lost: `logReceipts` is an append-only log with a caller-supplied
`receiptId` and no on-chain validation of contents, so receipts accrued during the window can be
backfilled afterward. Only the block timestamps will show the backfill.

**Your options:**

1. **Accept it** — deploy now, receipt log live at T+72h. Backfill the window.
2. **Start the clock early** — deploy UntchReceipts ≥72h before you need the receipt log live.
3. **Shorter delay** — `timelockDelay` is `immutable`. A shorter value is permanently shorter; there is
   no raising it later. This trades the §10.3 guarantee away for good.
4. **Change the contract** to take an initial writer — code change, re-test, re-review, and it
   contradicts the documented design above. Not recommended without a deliberate decision.

---

## 2. FINDING: three of your five addresses aren't used by this deployment

None of these four contracts takes an owner, an oracle, or a settlement token. Checked each constructor:

| Contract | Constructor | Roles set here |
|---|---|---|
| PolicyRegistry | *(none)* | none — permissionless, `onlyPolicyOwner` gates are per-policy |
| SpendIntentRegistry | `()` | deployer→admin, then **admin**, **writer** |
| UntchReceipts | `(uint64 delay)` | deployer→admin, then **admin**, **writer** (at T+72h) |
| UntchVaultFactory | `(address intentRegistry)` | none |

`owner`, `oracle`, the USDT0 allowlist and `requireAnchoredIntent=true` are all **per-vault**
arguments to `deployVault(owner, agent, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow[],
requireAnchoredIntent)` — they get supplied later, per operator, not now. The script still validates all
five addresses are pairwise distinct before sending anything, resolves real USDT0
(`0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, 6 dp) from `chains.ts`, asserts it has live code on 196,
and records it in the run artifact for that later step.

The one carried-forward wiring is the Factory's canonical immutable `intentRegistry`, which is set to
SpendIntentRegistry's **real deployed address** — hence the dependency order.

---

## 3. Funding

**Fund the deployer address with `0.05 OKB`.**

Gas measured by actually deploying all four contracts on an anvil fork of mainnet (not estimated):

| Step | Gas |
|---|---|
| PolicyRegistry deploy | 556,622 |
| SpendIntentRegistry deploy | 612,817 |
| UntchReceipts deploy | 655,920 |
| UntchVaultFactory deploy | 1,617,020 |
| Phase 1 writes (addWriter, transferAdmin, 2× propose) | 174,569 |
| Phase 2 writes (2× execute) | 82,479 |
| **Total** | **3,699,427** |

X Layer mainnet gas price read live: **0.02 gwei** (`eth_gasPrice` = 20,000,001 wei, matching the
latest block's `baseFeePerGas` of 20,000,000 — this is the chain's floor and it was stable across
samples).

- At live price: **0.000074 OKB**
- At a 100× spike: 0.0074 OKB

0.05 OKB is ~676× headroom over the live price and costs a couple of dollars. The deployer needs a
balance in **both** phases — don't drain it after phase 1.

No other address needs funding. Admin, writer, owner and oracle receive roles or are recorded; none of
them sends a transaction in this runbook.

---

## 4. Commands — run these yourself, in your own terminal

Set your five real addresses once. `DEPLOYER_PRIVATE_KEY` stays in your shell and never leaves it.

```bash
cd /Users/mac/untch

export OWNER_ADDRESS=0x...      # per-vault later; validated for distinctness now
export ORACLE_ADDRESS=0x...     # per-vault later; validated for distinctness now
export ADMIN_ADDRESS=0x...      # gets admin on SpendIntentRegistry + UntchReceipts
export WRITER_ADDRESS=0x...     # authorized writer on both registries
export RPC_URL=https://rpc.xlayer.tech
export ALLOW_MAINNET=1
export TIMELOCK_DELAY=259200    # 72h — IMMUTABLE once deployed
```

### Step 1 — role separation (no key, nothing sent)

```bash
DEPLOYER_ADDRESS=0x<your-deployer-public-address> pnpm verify:role-separation
```

### Step 2 — preflight (no key, read-only; prints funding + confirms USDT0 is live)

```bash
pnpm deploy:mainnet-suite
```

### Step 3 — fund the deployer with 0.05 OKB, then confirm it landed

```bash
DEPLOYER_ADDRESS=0x<your-deployer-public-address> pnpm check-wallet
```

### Step 4 — PHASE 1: deploy all four + wire + propose

Add your key to the environment only at this point.

```bash
export DEPLOYER_PRIVATE_KEY=0x<your-deployer-private-key>

BROADCAST=1 PHASE=1 pnpm deploy:mainnet-suite
```

This deploys the four contracts in dependency order, authorizes the writer on SpendIntentRegistry and
hands it admin, then proposes `ADD_WRITER` and `TRANSFER_ADMIN` on UntchReceipts. It reads every value
back off-chain and aborts on any mismatch.

It writes `deployments/mainnet-suite.json` with the addresses and the exact `eta`. **Keep that file** —
phase 2 reads it.

The deployer intentionally still holds UntchReceipts admin after phase 1. It has to: `propose` and
`execute` are both `onlyAdmin`, so admin can only be handed away as the very last act of phase 2.

Phase 1 prints the exact UTC timestamp phase 2 becomes possible.

### Step 5 — wait 72 hours

Close the terminal; nothing is running. The proven `deploy-keyed-suite.ts` sleeps in-process for the
delay, which is fine at the testnet's 60s but would mean holding a terminal open for three days at 72h.
That's why this is split into two phases.

### Step 6 — PHASE 2: execute, at or after the eta

Same deployer key, same machine (or copy `deployments/mainnet-suite.json` across).

```bash
export DEPLOYER_PRIVATE_KEY=0x<your-deployer-private-key>

BROADCAST=1 PHASE=2 pnpm deploy:mainnet-suite
```

Executes `ADD_WRITER` then `TRANSFER_ADMIN` — **admin last**, or the deployer would hand away admin
before it could execute the writer add. If you run this early it refuses locally with the time
remaining rather than burning gas on a `TimelockNotElapsed` revert.

After this the deployer holds **no live role on any contract**.

### Step 7 — independent verification

Phase 2 prints this line filled in with the real addresses; run it as printed.

```bash
RPC_URL=https://rpc.xlayer.tech \
RECEIPTS_ADDRESS=0x... SPEND_INTENT_REGISTRY_ADDRESS=0x... \
DEPLOYER_ADDRESS=0x... OWNER_ADDRESS=0x... ADMIN_ADDRESS=0x... \
WRITER_ADDRESS=0x... ORACLE_ADDRESS=0x... \
pnpm verify:deployment-roles
```

---

## 5. Rehearsal evidence

The full sequence was run against an anvil fork of real X Layer mainnet (chainId 196), including a 72h
time jump:

- Phase 1: four contracts deployed; readback `ok: true` — registry admin = ADMIN, registry writer =
  true, receipts admin = deployer (by design), receipts writer = false (timelock pending), receipts
  delay = 259200, factory `intentRegistry` = the real deployed SpendIntentRegistry address.
- Phase 2 attempted early: refused locally — *"Timelock not elapsed: 4320 min left"*.
- Phase 2 after the jump: readback `ok: true` — receipts admin = ADMIN, receipts writer = true,
  deployer is not a writer, registry admin = ADMIN, registry writer = true.

Real USDT0 resolved from `chains.ts` and confirmed to have live code on 196.

The fork rehearsal used throwaway addresses and anvil's dev key. No mainnet key was requested,
referenced, or handled at any point.
