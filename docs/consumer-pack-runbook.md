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
POST /internal/consumer/intents/preflight   # what production WOULD do. Writes nothing.
POST /internal/consumer/intents             # create one intent through the normal path.
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
| `refusals[]` | Every blocker, each with a code — not just the first |
| `productionMaturity` | The registry's real provider / capability / effective maturity |
| `publicMaturity` | The public label (LIVE / BETA / …), derived, never an input to the gate |
| `executionControls` | The standing switches, as booleans |
| `executionFloor` | Required, effective, and whether it is satisfied |
| `expectedSettlement` | The derived chain, asset, treasury ref and whether a signer stands |
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
