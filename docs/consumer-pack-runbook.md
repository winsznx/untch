# Consumer Pack runbook

Every operational procedure, written for someone who is holding a pager and did not build this.

Rules that apply throughout:

- **Never re-send a request whose outcome is unknown.** Query, then decide. Resending is a possible
  second purchase, not a retry.
- **Never edit a ledger entry.** They are append-only by database RULE. A correction is a reversing
  entry that stays visible.
- **A pause is cheap. Use it.** Engaging a kill switch costs one `INSERT` and blocks capability
  minting before anything reaches a rail.

---

## Where to look first

| Question | Surface |
|---|---|
| What is happening right now? | `/dashboard/consumer` |
| What happened to ONE action? | `/dashboard/consumer/<intentId>` |
| Are the floats healthy? | `/dashboard/consumer/treasury` |
| What is a provider actually rated? | `/dashboard/consumer/providers` |
| What needs a human? | `/dashboard/consumer/review` |

---

## Provider outage

**Symptoms:** `PROVIDER_UNAVAILABLE` in logs; the provider card shows *unreachable*; the circuit
breaker opens after `CONSUMER_BREAKER_THRESHOLD` consecutive failures.

1. Confirm from outside Untch: `curl -sS -o /dev/null -w '%{http_code}\n' https://<provider>/.well-known/x402`
2. If the provider is genuinely down, **pause it** so intents fail fast instead of timing out:
   ```sql
   INSERT INTO consumer_pause_flags (scope, target, paused, reason, set_by)
   VALUES ('PROVIDER', '<providerId>', TRUE, 'upstream outage <date>', '<operator>')
   ON CONFLICT (scope, target) DO UPDATE
     SET paused = TRUE, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, updated_at = now();
   ```
3. Intents already `EXECUTION_QUEUED` will fail into `FAILED_BEFORE_PAYMENT` → `REFUND_PENDING`. That
   is correct: no money moved.
4. Check for anything caught mid-flight:
   ```sql
   SELECT execution_id, intent_id, provider_id, state, started_at
     FROM consumer_provider_executions
    WHERE state IN ('SENT','AMBIGUOUS') ORDER BY started_at;
   ```
   Anything listed goes through **Ambiguous purchase or booking** below.
5. When the provider recovers, set `paused = FALSE`. The breaker half-opens on its own after
   `CONSUMER_BREAKER_COOLDOWN_MS`.

---

## Low provider wallet balance

**Symptoms:** `[consumer] LOW TREASURY BALANCE …` in logs; the treasury card shows the float below
its floor; new intents fail `TREASURY_INSUFFICIENT` *before* payment (correct — nothing was spent).

1. Read the exact position on `/dashboard/consumer/treasury`: on-chain balance, ledger position,
   floor, daily limit.
2. **Send funds to the float's public address from a normal wallet.** There is no automatic
   rebalancing and no bridge — this is deliberate, and `assertRebalancingDisabled()` will throw if
   anyone tries to enable one.
3. Wait for confirmations, then let the 30-second sweep re-observe, or restart the ASP.
4. Confirm the floor is cleared before resuming.
5. If this recurs, raise `CONSUMER_BASE_MIN_BALANCE` rather than topping up more often — the floor
   exists so one large purchase cannot strand everything queued behind it.

---

## Ambiguous purchase or booking

**The one that matters.** An intent sits in `MANUAL_REVIEW`; its funding is parked in a `SUSPENSE`
ledger account; nothing has been retried and nothing will be automatically.

1. Open `/dashboard/consumer/<intentId>`. Read the **execution attempts** panel — the provider
   reference is recorded even when the response was lost, because the row is written *before* the
   request leaves.
2. Check the merchant's own order surface for that reference (their status endpoint, their
   dashboard, the registrar's WHOIS, the DNS attestation — whatever is authoritative for that
   provider).
3. **If the merchant DID fulfil:**
   ```sql
   -- Release the suspense back into the obligation, then recognise it.
   -- Both are new rows. Nothing is edited.
   BEGIN;
   INSERT INTO consumer_ledger_groups (group_id, kind, intent_id, chain, token)
   VALUES ('lg_<new>', 'ADJUSTMENT', '<intentId>', '<fundingChain>', '<fundingToken>');
   -- +amount SUSPENSE, −amount USER_OBLIGATION  (the reverse of the SUSPENSE_MOVE)
   -- then a RECOGNITION group: +total USER_OBLIGATION, −fee, −spread, −costOfGoods
   COMMIT;
   UPDATE consumer_intents SET state = 'COMPLETED', updated_at = now()
    WHERE intent_id = '<intentId>' AND state = 'MANUAL_REVIEW';
   ```
4. **If the merchant did NOT:**
   ```sql
   -- +amount SUSPENSE, −amount REFUND_PAYABLE  (an ADJUSTMENT group)
   UPDATE consumer_intents SET state = 'REFUND_PENDING', updated_at = now()
    WHERE intent_id = '<intentId>' AND state = 'MANUAL_REVIEW';
   ```
   Then refund the user out of band and move the intent to `REFUNDED`.
5. **If you cannot tell:** leave it. An unresolved ambiguity with the money parked and accounted for
   is a better state than a guess. Escalate to the merchant.

Always keep the `WHERE … AND state = '<expected>'` clause — that is the same compare-and-set the
application uses, and it stops you racing a worker.

---

## Failed delivery verification

An intent reached `DELIVERY_VERIFIED` with `untchVerified.verified = false`.

This is **not** a failure. It means the merchant attested fulfilment and Untch could not
independently confirm it. For StableEmail (a relay hand-off) and Purch (a physical parcel), that is
the permanent, honest answer — there is no sender-side proof to have.

Only investigate when a provider that CAN be independently verified reports false — e.g.
StableDomains, whose `/api/domain/verify` reads a public DNS TXT attestation. Then: check the DNS
record yourself, allow for propagation, and re-run verification. A registration that never
propagates is a merchant dispute.

---

## Refund

1. Confirm the intent is `REFUND_PENDING` and that a `REFUND` ledger group exists.
2. Confirm the funding transaction on-chain and read the payer address.
3. Send the refund from the funding wallet.
4. Record it and advance:
   ```sql
   UPDATE consumer_intents SET state = 'REFUNDED', updated_at = now()
    WHERE intent_id = '<intentId>' AND state = 'REFUND_PENDING';
   ```
5. Verify `REFUND_PAYABLE` for that intent nets to zero after the offsetting entry.

---

## Compromised provider

A merchant is taking payment and not delivering, or its endpoint has been taken over.

1. **Pause it immediately** (see Provider outage, step 2).
2. **Demote it** so it cannot be un-paused into execution by accident:
   ```sql
   UPDATE consumer_providers SET maturity = 'disabled', enabled = FALSE, updated_at = now()
    WHERE provider_id = '<providerId>';
   ```
3. List every settlement to it:
   ```sql
   SELECT intent_id, settlement_tx_hash, settled_amount, started_at
     FROM consumer_provider_executions
    WHERE provider_id = '<providerId>' AND state IN ('PAID','ACKNOWLEDGED')
    ORDER BY started_at DESC;
   ```
4. Move affected intents to `MANUAL_REVIEW` and work them individually.
5. Only re-enable after a fresh live-evidence capture and a new onboarding checklist. Maturity
   restarts at `sandbox` — a previously-verified provider does not keep that status through a
   compromise.

---

## Compromised treasury wallet

Assume the key is gone.

1. **Pause the account and the chain, in that order** — the chain scope also stops any other account
   on the same rail:
   ```sql
   INSERT INTO consumer_pause_flags (scope, target, paused, reason, set_by)
   VALUES ('TREASURY_ACCOUNT', '<treasuryRef>', TRUE, 'key compromise <date>', '<operator>'),
          ('CHAIN', '<caip2 chain>', TRUE, 'key compromise <date>', '<operator>')
   ON CONFLICT (scope, target) DO UPDATE SET paused = TRUE, reason = EXCLUDED.reason, updated_at = now();
   ```
2. Sweep any remaining float to a safe wallet.
3. Rotate: generate a new key, set `CONSUMER_TREASURY_*_PRIVATE_KEY`, restart. The account row
   updates its `address` from the rail client at boot.
4. Reconcile: compare on-chain movement against `consumer_ledger_entries` for that account. Record
   the difference as an `ADJUSTMENT` group. **Do not** edit history.
5. Re-enable only after the new address is funded and reconciled.

---

## Chain outage

1. Pause the chain scope.
2. Intents on that rail fail before payment and refund. Intents on other rails are unaffected —
   that is what per-rail floats buy.
3. `AWAITING_FUNDING` intents on X Layer will expire naturally at `CONSUMER_FUNDING_TTL_SEC`.
4. Un-pause when the chain is producing blocks and the RPC is current.

---

## Reconciliation mismatch

The treasury card shows drift between the on-chain balance and the ledger position.

Drift is **recorded, never auto-corrected** — an automatic correction would make the ledger agree
with the chain by construction and destroy its value as an independent record.

1. Identify the window:
   ```sql
   SELECT observed_at, onchain, ledger, drift FROM consumer_treasury_balances
    WHERE treasury_ref = '<ref>' ORDER BY observed_at DESC LIMIT 50;
   ```
2. Ordinary causes: an inbound top-up (the ledger does not know about it), gas spent, or a settlement
   whose ledger group failed to write.
3. For a top-up, record an `ADJUSTMENT` group crediting the treasury account.
4. For a missing settlement group, find the execution and write the group it should have had.
5. Anything else is an incident. Pause the account and investigate before it moves again.

---

## Emergency pause and recovery

**Stop everything:**
```sql
INSERT INTO consumer_pause_flags (scope, target, paused, reason, set_by)
VALUES ('GLOBAL', '*', TRUE, '<why>', '<operator>')
ON CONFLICT (scope, target) DO UPDATE SET paused = TRUE, reason = EXCLUDED.reason, updated_at = now();
```

Takes effect on the next capability mint — within seconds, and **before** anything reaches a rail.
Intents in flight at `PROVIDER_PAYMENT_PENDING` are not recalled; they are already sent, and they
resolve through the normal ambiguity path.

**Resume:** set `paused = FALSE`, then work the manual-review queue before re-enabling providers.

---

## Promoting a provider to `verified`

All four are required. There is no shortcut, and no configuration flag substitutes for any of them.

1. **A funded treasury float on that provider's rail**, and its account `enabled`.
2. **A real settled payment** from an Untch treasury wallet:
   ```bash
   CONSUMER_SMOKE_ENABLED=1 CONSUMER_SMOKE_MAX_SPEND=1.00 pnpm consumer:smoke --provider <slug>
   ```
   This spends real money. The script refuses to exceed the cap.
3. **The settlement transaction re-read independently** — from a block explorer or a raw
   `eth_getTransactionReceipt`, not from the script's own stdout.
4. **Delivery verified through a path that is not the merchant's own assertion**, where the provider
   allows one.

Then, and only then:
```sql
UPDATE consumer_providers SET maturity = 'verified', updated_at = now() WHERE provider_id = '<slug>';
UPDATE consumer_provider_capabilities SET maturity = 'verified'
 WHERE provider_id = '<slug>' AND capability = '<the one you proved>';
```

Promote the **capability you actually proved**, not the whole provider. Record the transaction hash
in the provider's `provenance` string, and update `seed.ts` so a redeploy does not silently demote it.

---

## The operator control routes

Two authenticated routes let an operator drive one Consumer Intent against production **without
holding production's database credential, its treasury key, or any provider secret**.

```
POST /internal/consumer/intents/preflight    # what production WOULD do. Writes nothing.
POST /internal/consumer/intents              # create one intent through the normal path.
GET  /internal/consumer/intents/:intentId    # the production store's own view of one intent.
POST /internal/consumer/settlement-accounts  # register a PUBLIC settlement authority. No key accepted.
GET  /internal/consumer/settlement-accounts  # what is registered, and how sound each account is.
```

Both authenticate with `INTERNAL_OPS_TOKEN`, the same credential and the same constant-time
comparison `/internal/deployment-info` uses (`services/asp/src/internal-auth.ts`). Send it as
`Authorization: Bearer <token>`.

### Why they exist

A local driver that reaches production by holding production's `DATABASE_URL` **is** a production
component: it can write registry rows, construct a treasury signer and supply its own policy, so
every control the deployed service enforces becomes advisory. These routes move the boundary to HTTP.
The controller sends a bounded request; the ASP answers out of its own store, its own registry, its
own flags and its own policy provider.

### What the routes derive rather than accept

A provider URL, a recipient, a token mint, a chain configuration, a payment rail, a treasury address
and any maturity are all **refused with a 400** rather than silently overridden. The settlement chain
comes from the provider's registered `chains`, the asset from the confirmed asset registry for that
chain, and the recipient from the provider's own live payment challenge at execution time.

### The execution boundary

Neither route can execute a provider action. The create route may quote, run policy, reserve and
queue; the **deployed worker's `EXECUTION_QUEUED` poll is the only thing that pays anyone**.
`services/asp/test/consumer-operator-routes.test.ts` asserts this against an adapter whose `execute`
throws on sight.

### Preflight request

```jsonc
{
  "intentId": "ci_<24 lowercase hex>",   // exact, caller-supplied. Never minted by the route.
  "tenantId": "policy:<policyId>",
  "owner": "<owner or operator identity>",
  "provider": "<registry provider id>",
  "capability": "<a Consumer Pack action, e.g. shop.search>",
  "request": { },                         // the structured provider request
  "providerRef": "<merchant reference>",  // optional; never a URL. Defaults to the capability.
  "maxProviderAmount": "0.020000",
  "expectedSettlementChain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "expectedSettlementAsset": "USDC",
  "fundingMode": "operator-funded",       // or "externally-funded"
  "idempotencyKey": "<8-200 chars of [A-Za-z0-9._:-]>",
  "expiresAt": "2026-07-30T13:00:00.000Z" // optional; may only SHORTEN the normal TTL
}
```

Preflight answers **200 whether or not the plan is acceptable** — a refused plan is a successful
preflight. Read `accepted` and `refusals[]`, not the status code. It creates no intent, takes no
reservation, queues nothing, loads no signer and calls no provider.

### Reading the result

| Field | Meaning |
|-------|---------|
| `accepted` | Whether production would create this intent right now |
| `readinessClass` | `STRUCTURAL_BLOCKED` / `READY_TO_ARM` / `ARMED_AND_EXECUTABLE`. Derived from `refusals`, never set |
| `refusals[]` | Every blocker, each with a code — not just the first |
| `productionMaturity` | The registry's real provider / capability / effective maturity |
| `publicMaturity` | The public label (LIVE / BETA / …), derived, never an input to the gate |
| `executionControls` | The standing switches, as booleans |
| `executionFloor` | Required, effective, and whether it is satisfied |
| `expectedSettlement` | The derived chain and asset, plus four separate facts: `accountRegistered`, `accountFunded`, `signerConfigured`, `railExecutionEnabled`, and `signerMatchesAuthority` |
| `proofGate` | Whether the chain is governed, and whether an armed gate admits this intent |
| `deployment` | Phase, serving commit, deployment id, migration version, environment |

### Production identity

Both routes fail closed unless the instance can prove what it is: phase `READY`, a build attestation
(so the serving commit is known), a durable store, a known migration version, and the environment
marker `RAILWAY_ENVIRONMENT_NAME` (or an explicit `UNTCH_ENVIRONMENT`) reading `production`.

`UNTCH_OPERATOR_ROUTES_ALLOW_NON_PRODUCTION=1` exists for off-platform integration environments only.
It is reported in every response that uses it. **It must never be set on the production service.**

### Operator provenance

An intent created this way records, on its creation event: the source (`internal-operator-api`), the
route and route version, a **truncated one-way digest of the operator token** (never the token), the
request timestamp, a **hash of the request** (never the body), the idempotency key, the serving
commit, the serving deployment id and the environment. Public receipts never expose any of it.

### Readiness classes

`accepted: false` covers two situations an operator must never confuse, so the class separates them.

| Class | Meaning | What to do |
|-------|---------|------------|
| `STRUCTURAL_BLOCKED` | Something is wrong that arming will not fix: no policy, no registered settlement account, a capability below the execution floor, a frozen or delegated float, a gate armed for a different scope, a deployment that cannot prove itself | Stop. Fix the cause. Do not throw a switch |
| `READY_TO_ARM` | Every structural check holds. The only refusals left are switches | Arm the exact scope |
| `ARMED_AND_EXECUTABLE` | `accepted: true` and no refusals | Create the intent |

Only these refusal codes may appear in `READY_TO_ARM`: `EXECUTION_CONTROLS_DISABLED` (when its
`flagRefusal` is `PROVIDER_FLAG_DISABLED`, `CHAIN_DISABLED` or `ASSET_DISABLED`),
`SETTLEMENT_SIGNER_ABSENT`, `SETTLEMENT_RAIL_EXECUTION_DISABLED` and `PROOF_GATE_NOT_ARMED`. Anything
else is structural. `CONSUMER_PACK_ENABLED` or `CONSUMER_EXECUTION_ENABLED` being unset is deliberately
**not** an arming control: that instance is not running the Consumer Pack, and arming a treasury against
it would be arming the wrong deployment.

**A Solana settlement requires an armed gate.** With the standing controls on and no gate, the worker's
two-second poll may spend from the Solana treasury on *any* queued Solana intent. That is reported as
`PROOF_GATE_NOT_ARMED`, an arming control. A gate that is armed for a *different* intent, provider,
capability, ceiling or window is `PROOF_GATE_INCOMPATIBLE` and is structural.

---

## Registering a settlement account without a signer

Registering a float and being able to spend from it used to be one act: the account row was written
from `rail.address()`, which throws without a private key. So an unarmed deployment could not record
that a funded wallet existed, and preflight reported `SETTLEMENT_TREASURY_ABSENT` for a wallet that was
sitting there waiting. Four facts, now separate:

| Fact | Means |
|------|-------|
| registered | A public authority is recorded, with on-chain evidence |
| funded | The observed balance clears this authorisation plus the account's own floor |
| signer | A key is present in the serving process |
| executable | The rail's switch is thrown **and** the signer derives the registered authority |

```bash
curl -sS -X POST "$UNTCH_ASP_URL/internal/consumer/settlement-accounts" \
  -H "authorization: Bearer $INTERNAL_OPS_TOKEN" -H "content-type: application/json" \
  -d '{
    "treasuryRef": "solana-usdc-settlement",
    "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "asset": "USDC",
    "authority": "<PUBLIC base58 address>",
    "role": "bounded proof treasury",
    "minBalance": "0.000000",
    "dailyLimit": "0.050000",
    "expectedTokenBalance": "0.050000",
    "expectedNativeBalance": "0.010000",
    "enabled": true
  }'
```

The route reads the chain and stores what it found: the derived associated token account, its program,
its owner, the mint and decimals **taken from the registry rather than from the request**, the observed
balances, and the three fields a balance cannot show — account state, delegate and close authority. A
**frozen, delegated or closable** account is refused and **nothing is stored**: a delegate can move the
float, a close authority can sweep it, and a frozen account accepts an authorisation and then fails the
transfer after the gate has already been claimed.

It never accepts a key, under any field name. `expectedTokenBalance` is checked against the chain and is
not the source of the recorded figure; it exists to catch the wallet mix-up that survives every other
check. Replacement is refused while any unsettled intent, live gate or `MANUAL_REVIEW` record exists —
re-pointing reconciliation and authorisation at a float nothing in flight was checked against.

When a signer is later loaded, `initConsumerWiring` compares its derived address to the registered
authority and **throws on a mismatch**, so the process never reaches `READY` and Railway never routes to
it. A mismatch discovered at payment time would be discovered after the gate had been claimed.

---

## Creating a production Consumer policy

```bash
pnpm consumer:policy:create --profile purch-shop-search-proof --dry-run   # print, sign nothing
pnpm consumer:policy:create --profile purch-shop-search-proof            # register for real
```

There is deliberately **no route that mints a policy row**. Every `StoredPolicy` carries a `policyHash`
anchored on X Layer mainnet by `PolicyRegistry.registerPolicy`, `runPolicy` binds that hash onto the
intent, and the projection commits to it. A row written without that anchor would carry a hash that
commits to nothing and would reduce every policy in the store to "as trustworthy as whoever holds the
operator token".

So the command drives the surface that already exists: `POST /create_spend_policy` returns **unsigned**
calldata, a dedicated wallet signs it and thereby becomes the on-chain owner, and
`POST /sync_policy_registration` makes the ASP read the confirmed `PolicyRegistered` event and store the
row with the owner **it** found on chain.

`registerPolicy` has no access control — `msg.sender` becomes the owner — so registering a policy grants
no authority over anything else, and the right signer is therefore the **least** privileged wallet
available. Set `CONSUMER_POLICY_OWNER_PRIVATE_KEY` to a dedicated wallet holding only gas. The command
**refuses by derived address** if it is the admin, operator, writer, oracle, Base treasury or test-funder
key. Holding the most gas is a reason to leave a key alone, not a reason to use it.

What the policy actually enforces, stated exactly because this is the easiest place to write a claim
nothing checks:

| Control | Enforced by |
|---------|-------------|
| Capability (`shop.search` only) | The engine, via `categories.allow` / `categories.deny` — the projection sets `category` to `consumer.<action>` |
| Funding-token per-call cap and daily budget | The engine, in DISPLAY units of the **funding** token (X Layer USDT0) |
| One action, duplicates, cooldown, expiry | The engine |
| `0.020000 USDC` settlement ceiling | **Not the policy.** The operator route's `maxProviderAmount`, `CONSUMER_SOLANA_PROOF_MAX_USDC`, and the payment capability the treasury router mints |
| Provider identity (`purch` only) | **Not the policy.** There is no provider rule in the engine. The production registry, `CONSUMER_PROVIDER_PURCH_ENABLED`, and the proof gate's `providerId` |

The provider allowlist is recorded in the ruleset so the anchored hash covers the operator's full stated
intent, and it is labelled in the metadata as recorded rather than enforced.

---

## Driving one production intent from a local controller

```bash
env -u DATABASE_URL -u CONSUMER_TREASURY_SOLANA_SECRET_KEY -u CONSUMER_TREASURY_BASE_PRIVATE_KEY \
    -u CONSUMER_SOLANA_PROOF_SECRET_KEY -u OPERATOR_PRIVATE_KEY -u ADMIN_PRIVATE_KEY \
  UNTCH_ASP_URL=https://asp.untch.xyz \
  INTERNAL_OPS_TOKEN=... \
  UNTCH_EXPECTED_SERVING_COMMIT=<full 40-char SHA> \
  pnpm consumer:smoke:live --deployed-worker-only --provider purch --operator-funded \
    --policy-id <id> --intent-id ci_<24 hex> --preflight-only
```

Drop `--preflight-only` to create. The controller reads **only** `UNTCH_ASP_URL`,
`INTERNAL_OPS_TOKEN` and `UNTCH_EXPECTED_SERVING_COMMIT`, and **refuses to start** if any known
database, treasury, signer or provider credential is present in its environment — not because it would
use one, but because a process holding one cannot claim that what it reports is evidence about the
deployed service.

`--deployed-worker-only` is a **separate entrypoint with a separate import graph**, not a flag inside the
local smoke script. `scripts/consumer-smoke-live-entry.ts` dispatches with `await import()` so exactly
one implementation is ever loaded, and `scripts/test/proof-controller-imports.test.ts` walks the real
graph to assert the controller reaches no store, signer, adapter or rail client. Its closure is four
modules and zero npm packages. The local script **refuses** the flag outright if the dispatcher is
bypassed.

The tenant is derived from `--policy-id` through the canonical helper. `--tenant-id` may be passed and is
checked, but a value that disagrees is a refusal rather than an override: `tenantId = policy:<policyId>`
is one binding, not two.

---

## Arming and disarming the Solana proof gate

### Arming

Set every variable in one operation, then redeploy. A partially-armed gate is refused at boot.

| Variable | Meaning |
|----------|---------|
| `CONSUMER_SOLANA_PROOF_MODE` | `1` to construct the gate at all |
| `CONSUMER_SOLANA_PROOF_INTENT_ID` | The one intent id authorised |
| `CONSUMER_SOLANA_PROOF_PROVIDER` | The one provider |
| `CONSUMER_SOLANA_PROOF_CAPABILITY` | The one capability |
| `CONSUMER_SOLANA_PROOF_MAX_USDC` | The ceiling. A refusal, not a clamp |
| `CONSUMER_SOLANA_PROOF_EXPIRES_AT` | ISO 8601. The gate refuses at or after this instant |

The gate **narrows** an authority that `CONSUMER_SOLANA_EXECUTION_ENABLED` grants; it never grants
one. With no gate armed, the standing execution controls alone govern the rail.

### Disarming

> **Configuration deletion without a new serving container is not a completed disarm.**
>
> Variables are read at process start. A deleted variable changes nothing for a container that is
> already running, and that container keeps serving until it is replaced. A disarm that stops at the
> deletion has removed the record of the authority while leaving the authority in place — which is
> strictly worse than not having disarmed at all, because the posture map now says "off".

**Run the command, not the checklist:**

```bash
pnpm solana:proof:disarm             # what it would delete, and the current posture
pnpm solana:proof:disarm --confirm   # delete, verify, redeploy, verify again
```

It removes the eleven armed values **secret first** — so that after step one no subsequent redeploy can
sign anything, whatever else is still set — verifies each is absent by re-reading the variable list,
forces a new container, waits for a serving deployment id that differs from the old one **and** a start
time after the deletions, and only then reports success, on the new container's own posture. A run that
is interrupted halfway has still completed the half that matters.

No `-y` on any deletion. `railway redeploy` carries `--yes` because the CLI's confirmation there cannot
be answered non-interactively, and the step it guards removes authority rather than granting it — a
redeploy that could not run would leave the armed container serving.

The steps below are what the command does, kept for the case where it has to be done by hand.

The only accepted deletion command:

```bash
railway variable delete <NAME> --service untch-asp --json
```

Require a parsed response containing `"deleted": true`. Anything else — a non-zero exit, an empty
body, an unparseable body — is a failed deletion, not a completed one.

**After each deletion**, re-read the variables and verify the name is absent:

```bash
railway variables --service untch-asp --json | jq 'has("<NAME>")'   # must print false
```

**After all deletions**, force a new container and verify it is the one serving:

1. Redeploy or restart the service.
2. Wait for a **new serving deployment id**.
3. Verify the new container's start time is **after** the deletions.
4. `GET /healthz` returns HTTP 200 with `phase: "READY"`.
5. `GET /internal/deployment-info` (authenticated) reports:
   - `solana.signer: "absent"`
   - `solana.execution: "disabled"`
   - `proofGate.proofMode: "disabled"`
   - `settlementRails: ["eip155:8453"]` — Base only

Only when all five hold is the disarm complete. Record the new deployment id and serving commit
alongside the deletion output; the deletion output alone is not evidence.
