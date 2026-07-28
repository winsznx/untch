# Mainnet writer activation runbook

**Date:** 2026-07-28
**Chain:** X Layer mainnet (`eip155:196`) · RPC `https://rpc.xlayer.tech`
**Contract:** `UntchReceipts` at [`0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95`](https://www.oklink.com/x-layer/address/0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95)
**Admin:** `0xD9eD4D474B0D01031d10d637546450F39ed6a5ba` — **you hold this key; I do not**
**Writer to activate:** `0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5`

Everything below was read off the deployed contract and its source, not inferred. Method names, the
enum, the `opId` derivation and the delay are all verified live (§0).

---

## 0a. PROPOSAL SUBMITTED — 2026-07-28T11:46:46Z

| | |
|---|---|
| **Transaction** | [`0xe5b7a9d3a6060cba305e5171b2296c7de4a7e0abd0554e13c55f3b2af5e055d5`](https://www.oklink.com/x-layer/tx/0xe5b7a9d3a6060cba305e5171b2296c7de4a7e0abd0554e13c55f3b2af5e055d5) |
| Block | 66470170 |
| Proposed at | `1785239206` — 2026-07-28T11:46:46Z |
| Operation id | `0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa` |
| Kind | `1` — `OpKind.ADD_WRITER` |
| Target | `0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5` |
| Value sent | `0` |
| **Earliest execution (ETA)** | **`1785498406` — 2026-07-31T11:46:46Z** |

Simulated before sending: signer `== admin()`, correct contract, `kind == ADD_WRITER`, correct
writer, zero value, and `opEta == 0` so no duplicate could be created. `simulateContract` returned the
same `opId` the pure `opId()` view returns.

> The submitting call errored on `waitForTransactionReceipt` with `block is out of range` — an RPC
> lag, not a failed transaction. **The proposal landed.** Confirmed by reading `opEta` directly and
> then recovering the tx from the `OpProposed` event. Worth recording: a receipt-fetch failure is not
> evidence a transaction failed, and re-sending on that assumption would have hit `OpAlreadyPending`.

**Skip §2–§4 below — they are done.** Resume at §5 to re-read state, then §6 on or after the ETA.

---

## 0. Verified live state, 2026-07-28

```
admin()                    → 0xD9eD4D474B0D01031d10d637546450F39ed6a5ba
timelockDelay()            → 259200            (3 days, IMMUTABLE)
isWriter(0x03e5…1ab5)      → false             ← the reason anchoring fails
opId(ADD_WRITER, 0x03e5…)  → 0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa
opEta(that id)             → 1785498406        (was 0; now PROPOSED — see §0a)
```

The `opId` was cross-checked: the value the contract returns is identical to
`keccak256(abi.encode(uint8(1), address))` computed locally. So the id above is correct and can be
used for reads before any transaction exists.

---

## 1. The exact API

From `contracts/src/UntchReceipts.sol` and `contracts/src/AuthorizedWriters.sol`. **These are the real
names — nothing here is invented.**

```solidity
enum OpKind { NONE, ADD_WRITER, REMOVE_WRITER, TRANSFER_ADMIN }   // ADD_WRITER == 1

function propose(OpKind kind, address target) external onlyAdmin returns (bytes32 id);
function execute(OpKind kind, address target) external onlyAdmin;
function cancel(OpKind kind, address target)  external onlyAdmin;
function opId(OpKind kind, address target) public pure returns (bytes32);

mapping(bytes32 opId => uint64 eta) public opEta;      // → opEta(bytes32) view
mapping(address writer => bool authorized) public isWriter;  // → isWriter(address) view
uint64 public immutable timelockDelay;                 // → timelockDelay() view
address public admin;                                  // → admin() view

event OpProposed(bytes32 indexed opId, OpKind indexed kind, address indexed target, uint64 eta);
event OpExecuted(bytes32 indexed opId, OpKind indexed kind, address indexed target);
```

**`OpKind` is passed as `uint8`.** `ADD_WRITER = 1`. Passing `0` (`NONE`) reverts `InvalidOpKind()`.

Errors you may legitimately see:

| Selector | Error | Means |
|---|---|---|
| `0x5d94d23c` | `NotWriter(address)` | the current failure — `logReceipts` called by an unauthorised signer |
| `0x17a84242` | `NotAdmin(address)` | you are not calling from the admin key |
| `0xb01a2678` | `OpAlreadyPending(bytes32)` | this exact op is already proposed — read `opEta`, do not re-propose |
| `0xd7a2195e` | `OpNotFound(bytes32)` | executing something never proposed (or already executed/cancelled) |
| `0x0597d240` | `TimelockNotElapsed(bytes32,uint64,uint64)` | the 3 days have not passed |
| `0x7fee227a` | `AlreadyWriter(address)` | the writer is already authorised — nothing to do |

---

## 2. Step 1 — connect the admin wallet

The admin is `0xD9eD4D474B0D01031d10d637546450F39ed6a5ba`, which is also the ASP's x402 `payTo`. It
currently holds **0.049928 OKB**, which is ample for both transactions.

**Option A — OKLink write UI (no key handling):**

1. Open https://www.oklink.com/x-layer/address/0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95
2. **Contract → Write Contract → Connect Wallet**
3. Connect the wallet holding the admin key. Confirm the connected address renders as
   `0xD9eD…a5ba` before doing anything else.

**Option B — `cast` (Foundry), key held locally:**

```bash
export XL_RPC=https://rpc.xlayer.tech
export RECEIPTS=0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95
export WRITER=0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5

# Confirm the key you are about to use IS the admin, before spending gas.
cast wallet address --private-key $ADMIN_PRIVATE_KEY
cast call $RECEIPTS "admin()(address)" --rpc-url $XL_RPC
# these two MUST match
```

---

## 3. Step 2 — propose the writer

```bash
cast send $RECEIPTS "propose(uint8,address)" 1 $WRITER \
  --rpc-url $XL_RPC \
  --private-key $ADMIN_PRIVATE_KEY
```

`1` is `OpKind.ADD_WRITER`.

**OKLink UI equivalent:** function `propose`, `kind` = `1`, `target` =
`0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5`.

Expected: one `OpProposed` event with
`opId = 0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa`, `kind = 1`,
`target = 0x03e5…1ab5`, and `eta = <block timestamp> + 259200`.

---

## 4. Step 3 — verify the proposal transaction

```bash
cast receipt <PROPOSE_TX_HASH> --rpc-url $XL_RPC | head -20
```

Expect `status 1 (success)`. On the explorer, open the tx and confirm the **Logs** tab shows
`OpProposed`. If `status 0`, decode the revert selector against §1's table — `NotAdmin` means the
wrong key, `OpAlreadyPending` means it was already proposed and you should skip to §5.

---

## 5. Step 4 — read the pending op and its execution timestamp

```bash
# The id is deterministic; you do not need the tx to compute it.
cast call $RECEIPTS "opId(uint8,address)(bytes32)" 1 $WRITER --rpc-url $XL_RPC
# → 0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa

cast call $RECEIPTS "opEta(bytes32)(uint64)" \
  0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa --rpc-url $XL_RPC
```

- `0` → **nothing is pending.** The proposal did not land; go back to §3.
- non-zero → that is the **earliest executable unix timestamp**.

```bash
ETA=<the value above>
date -r $ETA -u                       # macOS: human-readable UTC
echo $(( ETA - $(date +%s) )) seconds remaining
```

---

## 6. Step 5 — wait the full three days

**259200 seconds. There is no way to shorten it.** `timelockDelay` is `immutable`, set in the
constructor, so there is no setter to call and no admin path around it. This is the control working
as designed: an adversarially fuzzed invariant in the contract's test suite asserts that a change
proposed at T cannot take effect before T + delay under any caller or ordering.

Executing early reverts `TimelockNotElapsed(opId, eta, nowTs)` and wastes gas only.

---

## 7. Step 6 — execute the activation

```bash
cast send $RECEIPTS "execute(uint8,address)" 1 $WRITER \
  --rpc-url $XL_RPC \
  --private-key $ADMIN_PRIVATE_KEY
```

**OKLink UI:** function `execute`, `kind` = `1`, `target` = `0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5`.

Expected: `OpExecuted(opId, 1, 0x03e5…1ab5)`, and `opEta(id)` returns to `0`.

---

## 8. Step 7 — verify the writer is authorised

```bash
cast call $RECEIPTS "isWriter(address)(bool)" $WRITER --rpc-url $XL_RPC
# → true
```

**Do not proceed past this line until it returns `true`.** Everything downstream depends on it, and
re-driving into an unauthorised writer just burns the retry budget again.

---

## 9. Step 8 — re-drive the degraded receipts

Tell me once §8 returns `true` and I will run this, or run it yourself:

```bash
export PGURL="<Railway DATABASE_PUBLIC_URL>"
export RECEIPT_WRITER_ADDRESS=0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5

pnpm tsx scripts/receipt-redrive.ts            # report only
pnpm tsx scripts/receipt-redrive.ts --apply    # re-drive
```

The script refuses if the signer is below a gas floor, so a fresh gas problem cannot be mistaken for
an authorisation one. It re-drives the **same batch carrying the same `receiptId`** — it never mints
a replacement, because a new id would break every reference already published and would assert that
the original decision did not happen.

The deployed worker's `flushPendingOnce` sweep picks the batch up on its next reconcile tick.

---

## 10. Step 9 — verify the recovered mainnet transaction

```sql
SELECT receipt_id, status, tx_hash, block_number FROM receipts WHERE status <> 'CONFIRMED';
SELECT id, status, attempts, tx_hash FROM batches ORDER BY id DESC LIMIT 3;
```

Then check the transaction is genuinely on **mainnet**:

```bash
cast receipt <ANCHOR_TX_HASH> --rpc-url $XL_RPC | head
```

> **This check matters more than it looks.** Every previously "CONFIRMED" receipt in this database is
> a **testnet** anchor against `0x0c64997277b7d94d2999dea22a123cac56334863`. A tx hash alone does not
> tell you which network it is on. Confirm `to` equals the mainnet `UntchReceipts`
> `0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95`.

Explorer: `https://www.oklink.com/x-layer/tx/<ANCHOR_TX_HASH>`

---

## 11. Step 10 — confirm the public receipt flips to ANCHORED

```bash
curl -s https://asp.untch.xyz/consumer/receipt/ci_82bb2216c02366bc1b839a00 | jq '.receipt'
```

| Before | After |
|---|---|
| `{"state":"ANCHOR_FAILED","status":"DEGRADED_UNANCHORED"}` | `{"state":"ANCHORED","txHash":"0x…","blockNumber":…}` |

The page at https://untch.xyz/receipt/ci_82bb2216c02366bc1b839a00 changes its banner from
*"Not anchored"* to *"Anchored on X Layer"* with a link to the transaction.

**Only after this returns `ANCHORED` may any public surface say receipts are mainnet-anchored.** Until
then the wording in `internal/public-claims-matrix.md` stands.

---

## 12. Rollback — what is and is not possible

| Situation | Recourse |
|---|---|
| Proposed, not yet executed | `cancel(1, writer)` from admin. Clears `opEta`; nothing took effect. |
| Executed, want to undo | `propose(2, writer)` (`REMOVE_WRITER`) → **wait another 3 days** → `execute(2, writer)`. |
| Wrong address proposed | `cancel` it, then propose the right one. The 3-day clock restarts. |
| Want a shorter delay | **Impossible.** `timelockDelay` is `immutable`. |
| Anchoring still fails after activation | Not an authorisation problem — decode the new selector. `logReceipts` is separately gated on a non-empty batch (`EmptyBatch()`). |

**The asymmetry is deliberate.** Adding a writer takes 3 days; so does removing one. A faster removal
path would be a faster *addition* path for anyone who compromised the admin key, since they could add
a writer, use it, and remove it inside the window.

**Nothing here can lose money.** `UntchReceipts` holds no funds — no `payable`, `receive` or
`fallback`. The worst outcome of a mistake is a wasted gas fee and another 3-day wait.

---

## 13. One-shot status check

Run this at any point to see exactly where the process stands:

```bash
export XL_RPC=https://rpc.xlayer.tech
export RECEIPTS=0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95
export WRITER=0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5
ID=0xb4d6ce980c9c18a1d08e23abafa972cd4d82b78a0fc2e27935f7ced80ed4ddfa

echo "isWriter : $(cast call $RECEIPTS 'isWriter(address)(bool)' $WRITER --rpc-url $XL_RPC)"
echo "opEta    : $(cast call $RECEIPTS 'opEta(bytes32)(uint64)' $ID --rpc-url $XL_RPC)"
echo "now      : $(date +%s)"
```

| `isWriter` | `opEta` | Meaning |
|---|---|---|
| `false` | `0` | **current state** — nothing proposed yet. Start at §3. |
| `false` | `> now` | proposed, waiting. Execute at `opEta`. |
| `false` | `<= now` | ready — run §7 now. |
| `true` | `0` | **done.** Proceed to §9. |
