# The settlement boundary the approval path has to survive

This locks the design decisions that migration 028 depends on. It follows
[the lifecycle audit](./x402-settlement-lifecycle.md), which established that the business handler's
transaction commits before settlement runs and that the library exposes no general post-settlement
hook.

Two further findings from reading `@okxweb3/x402-core@0.1.0` change what "settled" is allowed to mean.

## Finding 1: a 2xx with settlement headers does not prove confirmed settlement

`processSettlement` returns `success: true` for **two** facilitator statuses:

```js
if (settleResponse.status === "success" || settleResponse.status === "pending") {
  return { ...settleResponse, success: true, headers: this.createSettlementHeaders(settleResponse), requirements };
}
```

A `pending` settlement is one the facilitator accepted but has not confirmed on chain. It produces
`success: true`, real settlement headers, and a 2xx response that is byte-indistinguishable from a
confirmed one at the HTTP layer.

So the settlement header is evidence that the facilitator **accepted** the transfer. It is not
evidence that the transfer **confirmed**. Anything that activates a human-facing promise on the
strength of that header is trusting a status the header does not carry.

This is why the activation contract requires authoritative evidence rather than the response.

## Finding 2: there is an authoritative status API, and one narrow official hook

- `facilitatorClient.getSettleStatus(txHash)` exists and is implemented by `OKXFacilitatorClient`. It
  returns `{ success, status }`. This is the reconciler's evidence source.
- `resourceServer.onSettlementTimeout(hook)` exists, but only fires on the timeout path. It is not a
  general post-settlement callback.
- `processSettlement` returns a rich result carrying `transaction`, `network`, `status` and
  `requirements`, so the values a reconciler needs are available when it runs.

No fork is required to read settlement status. A fork would only be required to intercept settlement,
and the retry decision below avoids needing that.

## The two identities

They are not the same thing and must never collapse into one column.

| | `serviceCallId` | `authorizationNonce` |
|---|---|---|
| What it identifies | one requested Untch service | one EIP-3009 payment attempt |
| Derived from | account, route, client idempotency key, canonical request fingerprint, service, policy selection context | the signed authorization |
| Lifetime | stable across retries | one attempt only |
| Cardinality | one per logical request | many per service call, at most one settled |
| Role | idempotency and replay identity | settlement correlation key |

The nonce is the only identifier present at handler time that a later settlement can be matched back
to, which is why it is the correlation key. It is a poor identity for the service call, because a
client retry legitimately mints a new one for the same logical request.

Rule: **a settled service call may never accept another payment attempt.** More than one attempt is
allowed only while every earlier attempt is proven unsettled or failed.

## Cut points and recovery

Where the process can die, what survives, and who finishes the job.

| # | Cut point | Durable state after the cut | Recovery |
|---|---|---|---|
| 1 | before handler commit | nothing | client retries, same `serviceCallId`, fresh authorization |
| 2 | after handler commit, before settlement | service call `PAYMENT_AUTH_VERIFIED`, attempt `VERIFIED`, request `PROVISIONAL` | reconciler asks the facilitator about the nonce. No transaction hash exists yet, so absent evidence means unsettled, and the attempt becomes `ABANDONED` after its authorization validity window closes |
| 3 | during settlement | same as 2, attempt `SETTLEMENT_PENDING` | reconciler polls `getSettleStatus`. Genuinely unknown stays `UNKNOWN` and non-actionable |
| 4 | after settlement success, before headers | settlement exists on chain, service has no record of the hash | reconciler queries the facilitator by nonce and payer. This is the case that makes response-derived evidence insufficient |
| 5 | after headers, before response finish | as 4, hash recoverable from the facilitator | reconciler, as 4 |
| 6 | after finish trigger, before finalizer commit | as 4 or 5 | reconciler finalizes. The finish trigger is best effort and its absence changes nothing |
| 7 | after finalizer commit, before client receives response | request `PENDING`, one outbox event, service call `FINALIZED` | client retry resolves to the existing result and pays nothing |

The rule this table exists to enforce: **`response.finish` is a trigger, never the correctness
boundary.** Every cut point is recoverable from durable state plus an authoritative query, and cut
point 4 is recoverable only that way.

## Settlement evidence

Accepted as authoritative:

- `getSettleStatus(txHash)` reporting success
- a `processSettlement` result whose facilitator status is `success` and not `pending`
- an on-chain transaction whose decoded transfer matches the exact authorization nonce, payer, token,
  amount, recipient and chain

Never accepted:

- HTTP 2xx
- the presence of a settlement header, per finding 1
- a `pending` facilitator status
- the handler having committed
- the existence of a `PROVISIONAL` request
- an in-memory callback having fired
- an expected balance change

## The already-settled retry, and why option A

The dangerous case, stated plainly: a service fee settles, the approval activates, the response is
lost, and the client retries with a **fresh** authorization. The middleware settles on any 2xx. A
correctly idempotent handler returning the stored result would therefore be charged a second time. A
uniqueness constraint cannot help, because it fires after the transfer has already happened, and no
database constraint can undo an on-chain transfer.

**Selected: option A.** Resolve settled service-call idempotency in a route-level middleware mounted
**before** `paymentMiddleware`, and answer the replay there without ever calling `next()`.

Why not option B: teaching an adapter to skip settlement on an `ALREADY_SETTLED` handler result means
the request has already passed payment verification, and the only signals the middleware honours for
skipping are a non-2xx status, which discards the body we want to return, or
`SETTLEMENT_OVERRIDES_HEADER`, which is a protocol field for altering settlement terms rather than a
"do not charge" switch. Both bend protocol semantics to carry an application decision.

Why option A is safe:

- `requiresPayment` is never consulted, because the request does not reach the payment middleware.
- The replay response carries no settlement header, since nothing settled.
- It cannot become an unauthenticated oracle: it requires a valid account session **and** the exact
  idempotency identity before it returns anything, and it answers a caller who has already paid for
  precisely this service call.
- It needs no fork and no patch of the installed package.

What it must not do: return a replay for a service call that is not proven `FINALIZED`. A
`SETTLEMENT_PENDING` or `UNKNOWN` service call is not a free pass, and answering one as a replay would
hand out an unpaid result. Those cases fall through to the normal priced path, where a fresh
authorization is legitimate because no settlement is proven.

## Status models

Service call: `EVALUATED`, `PAYMENT_AUTH_VERIFIED`, `SETTLEMENT_PENDING`, `SETTLED`,
`SETTLEMENT_FAILED`, `FINALIZATION_PENDING`, `FINALIZED`, `CANCELLED`.

Payment attempt: `VERIFIED`, `SETTLEMENT_PENDING`, `SETTLED`, `FAILED`, `SUPERSEDED`, `ABANDONED`,
`UNKNOWN`.

`SETTLED` and `FINALIZED` are kept apart on purpose. A settled fee with no finalized approval is
exactly cut point 4, and a model that cannot express it cannot recover from it.

## Table naming

`untch_decision_service_calls` already exists and is a **cooldown clock** keyed by
`(partition_key, service_host)`. It has nothing to do with payment. The new tables are
`untch_x402_service_calls` and `untch_x402_payment_attempts`, so the payment lifecycle never shares a
table or a semantic type with rate limiting.

## What is deliberately not stored

No raw bearer token. No complete signed payment authorization. The attempt record keeps the nonce,
the validity window, payer, token, amount, `payTo`, chain, an authorization digest, verification and
settlement timestamps, settlement state, `paymentId` and transaction hash where available, and a
failure code.
