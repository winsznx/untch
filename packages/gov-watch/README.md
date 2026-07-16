# @untch/gov-watch

A lightweight poller over the governance events on the deployed contracts. When one fires, a human hears
about it through the existing escalation channels.

## Why

`UntchReceipts` sits behind a 72-hour timelock and has a `cancel()`. That is only a defense if somebody
notices the `OpProposed` in time to pull the lever. Without a watcher, the delay protects nothing — it
just means the attacker waits three days. This closes that.

## ABIs (CI)

Decode ABIs are pinned under `abi/UntchReceipts.json` and `abi/SpendIntentRegistry.json`.
`contracts/out` is gitignored, so CI never depends on a local `forge build`. Refresh those JSON files
from forge artifacts when the watched event surface changes.

It is deliberately **not an indexer**: no history, no query surface, no database. It keeps one durable
number (the last block scanned and delivered) and forgets everything else.

## What it watches, and what it deliberately does not

| Contract | Watched | Why |
|---|---|---|
| **UntchReceipts** | `OpProposed`, `OpExecuted`, `OpCancelled`, `WriterAdded`, `WriterRemoved`, `AdminTransferred` | Timelocked admin. `OpProposed` is the one that matters: it opens the cancel window. |
| **SpendIntentRegistry** | `WriterAdded`, `WriterRemoved`, `AdminTransferred` | Admin is **immediate** by design — no propose step, no cancel window. Detection is the only defense it has, which makes alerting more important here, not less. |
| **UntchVault** | `OracleChanged`, `OwnershipTransferStarted`, `OwnershipTransferred`, `Paused`, `Unpaused` | Listed and ready, but **no vault instances exist yet**. Nothing watches this today. |
| **PolicyRegistry** | *nothing* | It has no admin, no writer, no owner. Permissionless by design; `onlyPolicyOwner` is per-policy, not governance. There is no event to watch. |
| **UntchVaultFactory** | *nothing* | No roles at all. One immutable `intentRegistry` set at construction. `VaultDeployed` is activity, not governance. |

Watching the last two would be theatre — a subscription that can never fire reads as coverage while
providing none.

## Alerting reuses the escalation channels

It does **not** build a second notification stack. It uses the same `Channel` classes, credentials, and
config loaders as the approval path — via a new optional `notify()` method on the seam.

`notify()` exists rather than reusing `send()` because they are different things. `send()` renders *"The
agent wants to spend 40 USDT0. Untch held it and needs your OK"* with Approve/Deny buttons and a
single-use code, and the §27 authority check turns that answer into money moving. A governance alert has
no code, nothing to approve, and the operator's only lever is an on-chain `cancel()` from the admin key.
Pushing `OpProposed` through `send()` would claim an agent wanted to spend money and imply a Deny button
could stop a timelock. It cannot. A test asserts the governance copy never uses approve/deny grammar.

| Channel | `notify()` | |
|---|---|---|
| Telegram | yes | proven live |
| Discord | yes | credentials present, not live-fired |
| Slack | yes | credentials present, not live-fired |
| Photon (iMessage) | yes | needs Spectrum credentials |
| Dashboard | **no — deliberate** | A pull surface. `send()` may return ok without delivering because the escalation record already exists in the repo, so the inbox genuinely shows it. A `GovernanceAlert` has no such record — nothing writes it, no view reads it — so `notify()` could only return ok having made the alert readable nowhere. A silent ok is worse than no channel: the watcher would count the operator as notified. Needs a real governance-alert record + inbox view first. |

The watcher refuses to construct if no channel implements `notify()`, rather than running and telling
nobody.

## Two safety properties worth knowing

**The cursor does not advance past an undelivered alert.** If an alert reaches no channel, the range is
retried next tick. A duplicate governance alert is noise; a missed one can be a stolen writer key.

**`seen` means delivered, not observed.** Marking a log seen on sight would make the undelivered case
unrecoverable — the cursor would hold (correctly) but the rescan would skip the very log it was holding
for. Both of these were found by running against the real network, not by reading the code.

## Running it

```bash
# Against the mainnet suite, once phase 1 has deployed. Targets are read from the deployment artifact,
# so no addresses are hardcoded and nothing needs editing on deploy day.
pnpm gov-watch

# Against an explicit pair (e.g. the deployed testnet contracts)
RECEIPTS_ADDRESS=0x0C64997277b7D94d2999DEa22A123cac56334863 \
SPEND_INTENT_REGISTRY_ADDRESS=0xf87e50f83172c2DacE7D274e4c701212caEB1372 \
CHAIN_ID=1952 FROM_BLOCK=35236665 pnpm gov-watch
```

Needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (and/or the Discord/Slack pairs). A channel with no
credentials is skipped loudly, never stubbed.

| Env | |
|---|---|
| `ARTIFACT` | deployment artifact path (default `deployments/mainnet-suite.json`) |
| `RECEIPTS_ADDRESS` / `SPEND_INTENT_REGISTRY_ADDRESS` | override; skips the artifact |
| `CHAIN_ID` / `NETWORK` / `RPC_URL` | standard `chains.ts` selection |
| `CURSOR_FILE` | cursor path (default `deployments/gov-watch-cursor.json`) |
| `FROM_BLOCK` | seed the cursor; else start at head |
| `POLL_INTERVAL_SEC` | default 15 |

## Proofs

```bash
pnpm test:gov-watch                              # 11 tests, real committed log fixtures, no network
pnpm --filter @untch/gov-watch prove:testnet     # REAL testnet contract → REAL Telegram alert
anvil --fork-url https://rpc.xlayer.tech --port 8599
pnpm --filter @untch/gov-watch prove:fork        # fresh proposal → live tick() → REAL Telegram alert
```

`prove:testnet` replays the real 60s-timelock writer provisioning (blocks 35236666–35236737 on X Layer
testnet) off the live public RPC: real logs, real ABI decode, real alerts. The decoded `opId`
`0xb4d6ce98…` matches the one recorded in `contracts/deploy/receipt-writer-provisioning-receipt.json`,
which is an independent check that the decode is right.

## The honest gap

**Nothing is watching mainnet, because mainnet does not exist yet.** Phase 1 of
`internal/mainnet-deploy-runbook.md` has not been run. The moment it is, `pnpm gov-watch` reads the
artifact it writes and points at the real addresses with no code change.

**No real mainnet test proposal has been made**, and none can be from a session: `propose` is
`onlyAdmin`, and the admin key is the operator's alone. `prove:fork` makes a genuinely fresh proposal
against real contract bytecode with the real 72h delay — on an anvil fork of mainnet, because that is
the only place a session legitimately holds an admin key.

**Reorgs**: alerts fire at zero confirmations, on purpose. A reorged-away alert is a retraction the
operator can shrug at; a late one can be a stolen key. There is no retraction message today.
