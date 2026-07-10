# @untch/policy-store — durable, on-chain-anchored policy CRUD (PRD §6.2 / §8 / §10.1)

Replaces the ASP's old hardcoded fixture policy with **real, durable policy storage**: CRUD backed by
the **same Railway Postgres** the receipt writer (§7.4) uses — no second database — with **real
on-chain anchoring** through the deployed `PolicyRegistry` (§10.1). `preflight_payment` and
`create_spend_intent` now read real stored policies from here instead of a fixture.

## What it does

| Tool (in `@untch/asp`) | This package | Chain call (real testnet tx) |
|---|---|---|
| `create_spend_policy` | canonicalize+hash rules, derive id from the live nonce, store | `PolicyRegistry.registerPolicy` |
| `update_policy` | re-hash rules, sync new version | `PolicyRegistry.updatePolicy` |
| `pause_policy` / `resume_policy` | flip stored status | `PolicyRegistry.pausePolicy` / `resumePolicy` |
| `preflight_payment` (read) | load the stored policy for the engine | — (read-only `PolicyProvider`) |

Three real subsystems, kept consistent on every mutation: **`@untch/canon`** (hash the ruleset —
reused, never reimplemented) → **`PolicyRegistry`** (the real on-chain register/update/pause) →
**Postgres** (the durable row, written *after* the tx confirms, so a row never claims an anchor that
did not land).

## policyId consistency (the defining choice)

The Postgres `policies.id` **IS** the on-chain policyId:

```
policyId = uint256(keccak256(abi.encodePacked(owner, ownerNonce)))
```

- The nonce is read from the **live contract** (`nextPolicyId(owner)`) *before* registering — never an
  off-chain counter that could drift.
- The id is taken from the **confirmed `PolicyRegistered` event** and asserted to equal the prediction.
- So the same value identifies the policy in Postgres and on-chain; there is no separate mapping table.

`id` is stored as `NUMERIC(78,0)` because a uint256 does not fit in `BIGINT` (the same representation
the receipt writer uses for `policy_id`).

## Operator signing — INTERIM demo wallet (TEMPORARY), and the target state

`registerPolicy` / `updatePolicy` / `pausePolicy` are gated to `msg.sender == owner` — **direct, no
relayer, no signature path** (deliberately unlike `SpendIntentRegistry`'s writer-set: policies are
created *rarely by a human*, not constantly by software). The correct long-term flow is the
operator's **own wallet**, connected via the dashboard (§15) — our backend should never hold an
operator's key.

That dashboard does not exist yet. The honest interim: this package signs with the **same demo/burner
wallet the whole build has used, `0x98F43e…`**, supplied as `OPERATOR_PRIVATE_KEY`. It is labeled a
**TEMPORARY stand-in** everywhere it appears (`config.ts`, `registry.ts`, the ASP wiring + handlers,
this README). It is **not** a custodial "master operator key" for third parties — when real operators
exist, the demo wallet is replaced by each operator's own connected wallet.

**Target state (named requirement, not built now):** the backend **prepares the `registerPolicy`
calldata and returns it unsigned**; the operator's own connected wallet signs and submits it; we sync
the Postgres row once we observe the resulting on-chain confirmation. The demo shortcut must never be
mistaken for this intended architecture.

## Storage — the same instance, no second database

`002_policies.sql` lands in the receipt writer's existing Railway Postgres (shared, forward-only
`schema_migrations` history — `001_init.sql` is the receipt writer's). The migration runner uses the
**same advisory-lock key** as `@untch/receipt-writer` so cross-package/cross-process boot-time
migrations serialize on the shared table.

`policies` shape (§8): `id` (on-chain policyId), `owner`, `agent_id`, `version`, `status`
(`ACTIVE|PAUSED`; EXPIRED is *derived* from the rules' expiry, never stored — mirroring
`PolicyRegistry.isUsable`), `policy_hash`, `expiry`, `onchain_ref` (registry + register/last txs),
`rules` (JSONB, evaluated verbatim by `@untch/policy-engine`).

## Public surface

- **Write:** `PolicyService`, `ViemPolicyRegistry`, `loadOperatorConfig`.
- **Read:** `PolicyProvider`, `PgPolicyRepo`, `createPool`, `runMigrations`, `loadStorageConfig`.
- **Testing/reuse:** `InMemoryPolicyRepo`, `parsePolicyRules`, `PolicyRegistryChain` (+ `toEnginePolicy`).

## Run

```bash
pnpm --filter @untch/policy-store typecheck
pnpm --filter @untch/policy-store test                 # 17 unit tests, fake chain + in-memory repo, no I/O

# apply the policies migration into the SAME Railway Postgres (use its public proxy URL locally):
DATABASE_URL=postgresql://…proxy.rlwy.net:PORT/railway pnpm --filter @untch/policy-store migrate
```

## Env

```
DATABASE_URL          # required (read + write) — the receipt writer's Railway Postgres
OPERATOR_PRIVATE_KEY  # required to SIGN mutations — the interim demo wallet 0x98F43e… (TEMPORARY)
RPC_URL               # default https://testrpc.xlayer.tech
POLICY_REGISTRY       # default 0xe1d74c90801db0fa806c72eb818b7671b8233532 (post-lint-fix redeploy)
```

Testnet only — `loadOperatorConfig` targets X Layer testnet (chainId 1952); mainnet stays deferred
until the full §28 checklist clears.
