# Timelock-delay decision — UntchReceipts writer provisioning

**Decision date:** 2026-07-10
**Decision:** Keep the deployed **60-second** timelock delay for the testnet receipt-writer
provisioning. Do **not** redeploy. Gate mainnet behind a real hours-to-days delay.

## The question

To provision the receipt-writer service as an authorized writer on the deployed `UntchReceipts`
(§10.3), a writer-set change must pass through the contract's admin timelock: `propose(ADD_WRITER,
writer)` → wait the delay → `execute(...)`. Before provisioning the *production* writer key, the
delay itself had to be re-examined — it was set to ~60s for demo convenience when the contract
shipped and never revisited as a real decision.

## What the chain actually says (read directly, not from a JSON file)

```
contract      0x0c64997277b7d94d2999dea22a123cac56334863   (X Layer testnet, chainId 1952)
timelockDelay 60           # cast call ... "timelockDelay()(uint64)"  → 60
admin         0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b
batchCount    4
```

## The constraint that drives the decision: `timelockDelay` is `immutable`

```solidity
uint64 public immutable timelockDelay;   // UntchReceipts.sol:101
```

It is fixed at construction and can never be changed. So this is **not** "call a setter to raise the
delay." The only two real options are:

1. **Keep 60s** — provision through the existing, OKLink-verified contract.
2. **Redeploy** a fresh `UntchReceipts(48h)` and re-run the entire §28 provisioning against it.

## Why keep 60s (testnet)

- **Redeploying buys zero real security here.** The threat a timelock defends against — a
  compromised admin key silently swapping the writer set to redirect/forge receipts — is a
  *mainnet-funds* threat. On testnet the admin and writer are burner keys, there are no real funds,
  and receipts are demo data. A 48h notice window protects nothing that exists on testnet.
- **Redeploying is strictly destructive here.** The current contract is verified on OKLink and is
  the on-chain home of the **measured gas/receipt** numbers §17/§25/§10.4 promised (batch-of-1/10/50
  gas, `batchCount=4`, the demo `ReceiptLogged`/`ScoreAnchored`/`AuditAnchored` events, and the
  proven propose→wait→execute timelock trace). A new address orphans all of it and forces re-verify
  + re-measure for no gain.
- **Iteration speed matters at this stage.** A 60s delay lets the provisioning sequence be proven
  end-to-end in one sitting; a 48h delay would stall the build for two days with nothing learned.
- This is **not** silent reuse. It is an explicit, reasoned choice to keep the value *because* the
  security rationale for a longer delay does not apply on testnet — recorded here so the next person
  can correct it if the reasoning was wrong.

## The mainnet gate (non-negotiable, carried forward)

`timelockDelay` being immutable means the delay is a **deploy-time decision** — there is no path to
"fix it later." Therefore:

- **Mainnet `UntchReceipts` MUST be deployed with a real delay.** Recommended **48h**, with a
  **minimum-delay floor** (e.g. reject `delay < 24h` in the mainnet deploy script's preflight) so a
  fat-fingered short delay can never ship to mainnet.
- The mainnet writer-provisioning runbook inherits that delay: propose → wait the *real* 48h →
  execute. No shortcuts.
- This matches the standing project memory: *"60s is testnet-only; real hours–days value + possible
  min-delay floor must be decided before UntchVault/mainnet."* This decision keeps that gate open and
  makes it explicit in the deploy path, not just in a note.

## Consequence for this component

The provisioning script (`scripts/provision-receipt-writer.ts`) refuses X Layer mainnet (chainId
196) outright and runs the real 60s propose→wait→execute against testnet only. The mainnet delay is
enforced where a mainnet deploy would actually happen — a future `UntchReceipts` mainnet deploy
script — not here.
