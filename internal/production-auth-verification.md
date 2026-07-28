# Production authentication verification

**Date:** 2026-07-28
**Endpoint:** `https://asp.untch.xyz` (Railway, live)
**Change:** `CONSUMER_AUTH_REQUIRED=1`
**Result:** **14/14 passed, 0 failed**

---

## What changed and why

Tenant scope used to come from `?policyId=`, justified by the observation that a policy id is bound
to an owner wallet on chain. The binding is real; it was **never checked at request time**. A policy
id is public on-chain data, so anyone who read one off the explorer could pass it and receive that
tenant's intent amounts, provider, policy decisions — and through the SSE stream, their whole
lifecycle as it happened.

Deriving a tenant from a public identifier is namespacing, not authorisation.

`CONSUMER_AUTH_REQUIRED=1` refuses that path outright. Scope now comes only from a SIWE signature
over a server-issued, single-use, expiring nonce, verified against the policy's **on-chain owner**.

## Routes affected

**Now require a proven session (9):**

```
/consumer/intent/:intentId
/consumer/intent/:intentId/payment
/consumer/intent/:intentId/delivery
/consumer/intent/:intentId/receipt
/consumer/intent/:intentId/events        (SSE; accepts ?token= because EventSource cannot set headers)
/consumer/shop/order/:intentId
/consumer/domains/status/:intentId
/consumer/travel/booking/:intentId
/consumer/gifts/status/:intentId
```

**Deliberately unaffected (4):**

```
/consumer/receipt/:intentId    the public shareable receipt
/consumer/catalog              discovery
/consumer/auth/nonce           how a session is obtained
/consumer/auth/verify          how a session is obtained
```

## Caller impact

The only production caller of the scoped routes was the operator dashboard, which reads Postgres
directly and does not use these endpoints. No third-party integration was registered against them —
they were never listed on OKX.AI, and the re-registration package (`internal/okx-ai-consumer-pack-reregistration.md`)
had explicitly deferred announcing them until this flag was on. Nothing broke.

## The matrix — run against live production with real signatures

Nothing mocked. Nonces came from the deployed server; signatures were produced by freshly generated
keys; the ownership test used a **real** production policy owned by a wallet those keys are not.

| Attack / case | Expected | Actual | |
|---|---|---|---|
| wrong wallet / cross-tenant (valid signature, real policy, not the owner) | `403 NOT_POLICY_OWNER` | `403 NOT_POLICY_OWNER` | ✅ |
| replayed nonce (same message + signature twice) | `401 SIWE_NONCE_REPLAYED` | `401 SIWE_NONCE_REPLAYED` | ✅ |
| forged nonce (never issued by this server) | `401 SIWE_NONCE_REPLAYED` | `401 SIWE_NONCE_REPLAYED` | ✅ |
| wrong domain (signature phished for evil.example) | `401 SIWE_WRONG_DOMAIN` | `401 SIWE_WRONG_DOMAIN` | ✅ |
| wrong chain (Ethereum mainnet chainId 1) | `401 SIWE_WRONG_CHAIN` | `401 SIWE_WRONG_CHAIN` | ✅ |
| expired message (expirationTime in the past) | `401 SIWE_EXPIRED` | `401 SIWE_EXPIRED` | ✅ |
| malformed / garbage signature | `401 SIWE_BAD_SIGNATURE` | `401 SIWE_BAD_SIGNATURE` | ✅ |
| no untch:policy resource in the message | `401 SIWE_NO_POLICY_RESOURCE` | `401 SIWE_NO_POLICY_RESOURCE` | ✅ |
| public receipt remains public (no auth at all) | `200` | `200` | ✅ |
| private intent status with NO credentials | `401 AUTH_REQUIRED` | `401 AUTH_REQUIRED` | ✅ |
| ?policyId= alone (the legacy bypass) | `401 AUTH_REQUIRED` | `401 AUTH_REQUIRED` | ✅ |
| invalid bearer + valid ?policyId= (no fallback allowed) | `401 SESSION_INVALID` | `401 SESSION_INVALID` | ✅ |
| SSE event stream with ?policyId= only | `401 AUTH_REQUIRED` | `401 AUTH_REQUIRED` | ✅ |
| catalog remains public and reports required=true | `200 required=true` | `200 required=true` | ✅ |

## The two results worth reading twice

**`403 NOT_POLICY_OWNER`** — a *cryptographically valid* signature from a real wallet, naming a real
production policy, was refused. Owning a wallet is not owning a policy. This is the exact check the
query parameter never made, and the status code is deliberately distinct from `401`: one says "sign
again", the other says "wrong wallet".

**`401 SESSION_INVALID` on invalid-bearer + valid-`?policyId=`** — a bad token does not fall back to
the query parameter. Falling back would make presenting a broken token strictly better than
presenting none.

## Residual risk

- The SSE stream accepts the session as `?token=` because `EventSource` cannot set headers. The token
  therefore reaches access logs and `Referer`. Accepted because these sessions live 30 minutes and
  carry no capability beyond reading one tenant's intents — and it is still strictly better than a
  policy id, which never expires and is published on chain.
- Session revocation is secret rotation, not a per-session kill. Acceptable for a 30-minute TTL; it
  would not be for a long-lived token.

## Reproduce

```bash
node scripts/prod-auth-matrix.tmp.mjs
```
