# @untch/policy-store — durable, on-chain-anchored policy CRUD (PRD §6.2 / §8 / §10.1)

Replaces the ASP's old hardcoded fixture policy with **real, durable policy storage**: CRUD backed by
the **same Railway Postgres** the receipt writer (§7.4) uses — no second database — with **real
on-chain anchoring** through the deployed `PolicyRegistry` (§10.1). `preflight_payment` and
`create_spend_intent` now read real stored policies from here instead of a fixture.

## What it does

| Tool (in `@untch/asp`) | This package | Chain call (real testnet tx) |
|---|---|---|
| `create_spend_policy` | canonicalize+hash rules, **build UNSIGNED registerPolicy calldata** (never signs) | — (caller submits) |
| `sync_policy_registration` | read the confirmed `PolicyRegistered` event, store the row with the **real owner** | — (read-only `RegistryReader`) |
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

## Per-caller ownership — `create_spend_policy` NO LONGER signs (the target state, now built)

`registerPolicy` / `updatePolicy` / `pausePolicy` are gated to `msg.sender == owner` — **direct, no
relayer, no signature path**. The only way a caller becomes the on-chain owner is to submit the tx with
**their own key**. `create_spend_policy` now respects that instead of working around it:

- **`PolicyRegistrationService.buildCreate`** canonicalize+hashes the rules and returns the **UNSIGNED**
  `registerPolicy` calldata (`RegisterCall` — the viem request shape + raw `calldata`). It holds a
  key-free **`RegistryReader`** (`ViemRegistryReader`), so it is *structurally* unable to sign.
- the **caller's own wallet** signs + submits it and becomes the genuine on-chain owner.
- **`PolicyRegistrationService.syncRegistration`** reads the confirmed `PolicyRegistered` event and stores
  the row with `owner` taken from the event — **the real submitter, never assumed**. The supplied rules
  must hash to the anchored `policyHash` (`RULES_HASH_MISMATCH` otherwise), binding the stored ruleset to
  what the chain committed. Idempotent (a re-sync / dashboard-created policy → `alreadyStored`).

This is the same thing the dashboard already does (its connected wallet signs directly); the API path is
now at parity. Two distinct callers therefore end up as two distinct on-chain owners — proven end-to-end
on X Layer testnet (`contracts/deploy/multi-tenant-policy-testnet-receipt.json`), each owner independently
read back over raw RPC.

**`update_policy` / `pause_policy` / `resume_policy`** still sign server-side with the interim
demo/burner wallet `0x98F43e…` (`OPERATOR_PRIVATE_KEY`) — a **TEMPORARY stand-in** that can only ever
mutate a policy that operator itself owns. Bringing them to the same unsigned-calldata parity is the same
follow-up the dashboard's `buildUpdatePolicy` / `buildPausePolicy` already model; the interim wallet never
signs on another caller's behalf.

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
DATABASE_URL          # required — the receipt writer's Railway Postgres (create/sync record the row here)
OPERATOR_PRIVATE_KEY  # ONLY for update/pause/resume signing — the interim demo wallet 0x98F43e… (TEMPORARY).
                      # create_spend_policy needs NO key: it builds unsigned calldata; the caller signs.
RPC_URL               # default https://testrpc.xlayer.tech (create build + sync + update/pause use it)
POLICY_REGISTRY       # default 0xe1d74c90801db0fa806c72eb818b7671b8233532 (post-lint-fix redeploy)
```

Testnet only — `loadOperatorConfig` targets X Layer testnet (chainId 1952); mainnet stays deferred
until the full §28 checklist clears.
