# The x402 settlement lifecycle, as it actually runs

This is a trace of `@okxweb3/x402-express@0.1.1`, read from the installed package rather than from
its documentation. Every ordering claim below is a line in `dist/esm/index.mjs`.

It exists because the ApprovalRequest foundation depends on one question that has a
counter-intuitive answer: does the business handler's transaction commit before or after the service
fee settles.

It commits before.

## The ordering

1. `requiresPayment(context)` decides whether the route is priced. An unpriced route calls `next()`
   and nothing below happens.
2. `processHTTPRequest` verifies the presented authorization. Three outcomes: `no-payment-required`
   falls through, `payment-error` answers immediately with no handler run at all, and
   `payment-verified` continues.
3. On `payment-verified` the middleware replaces `res.writeHead`, `res.write`, `res.end` and
   `res.flushHeaders` with buffering stand-ins. Nothing the handler writes reaches the socket yet.
4. `next()` runs the business handler. **The handler's database transaction opens, commits and
   returns here.** The middleware then awaits the promise that the patched `res.end` resolves.
5. `if (res.statusCode >= 400)` the buffered response is flushed verbatim and the function returns.
   **`processSettlement` is never called.** This is the single line that makes every non-2xx refusal
   free, and it is what the `APPROVAL_PATH_NOT_READY` gate relies on.
6. Otherwise `processSettlement(paymentPayload, paymentRequirements, declaredExtensions, {...})` runs.
   This is the first moment money moves.
7. If settlement fails, the buffered handler response is **discarded** and the caller receives the
   facilitator's status and body instead. The handler's own 200 body is never sent, though everything
   that handler committed is still committed.
8. If settlement succeeds, the settlement headers are copied onto the response.
9. A `finally` block restores the real response methods and replays the buffered calls, so the
   response reaches the socket carrying the settlement headers.

## What follows from it

**Verification is not settlement.** A verified authorization means the signature and terms check out.
The transfer has not been submitted. Between step 3 and step 6 the money has not moved.

**The handler commits into an unsettled world.** Anything written in step 4 is durable regardless of
what step 6 decides. A handler that creates a PENDING, actionable ApprovalRequest has created a
promise to a human before knowing whether the fee was paid. If settlement then fails at step 7, that
row survives and an unpaid caller has a human on the hook.

That is the whole reason the approval model needs two states rather than one. PROVISIONAL is what a
handler is allowed to write at step 4. PENDING is what only a confirmed settlement may produce.

**There is no post-settlement callback.** The library exposes no hook between step 8 and step 9. The
only in-process signal that settlement succeeded is the settlement header on the response, readable
once the response finishes. So activation cannot be a middleware callback. It has to be:

- an activation triggered on response finish, which reads the settlement result, plus
- a reconciler that can finish the job from the payment reference alone, because the process can die
  between step 8 and any handler of ours.

**A settlement failure discards the handler's body.** Step 7 means a caller can receive a facilitator
error for a request whose side effects committed. Any state written at step 4 must therefore be
non-actionable on its own, and must carry enough identity for the reconciler to find it later.

**Retry is a fresh authorization, not a resumed one.** Nothing in the middleware records a spent
nonce for an attempt that ended before step 6. An attempt refused at step 5 leaves no protocol trace,
which is why the failsafe gate documents discard-and-re-sign as a client rule rather than claiming
the authorization was consumed.

## The identifier that links the three phases

`paymentPayload` carries the EIP-3009 authorization, whose `nonce` is unique per authorization and is
present at step 3, long before settlement. The settlement header produced at step 8 carries the
facilitator's `paymentId` and the on-chain `transaction`.

So the authorization nonce is the only value available at handler time that a later settlement can be
matched back to. It is the correlation key the service-call record must be keyed on. The facilitator
`paymentId` and transaction hash are recorded when they arrive, and are the values a reconciler
queries with.

## Consequences for the foundation

- An unsettled fee cannot create an actionable request, because step 4 may only write PROVISIONAL.
- A failed settlement cannot notify anybody, because the outbox event is written by the activation
  path at step 8 and later, never by the handler.
- One settlement cannot activate two requests, because activation locks the service call row keyed by
  the authorization nonce.
- An HTTP retry cannot charge twice, because a retry presents a fresh authorization with a fresh
  nonce and the finalizer refuses a service call that is already SETTLED.
- A settlement that succeeded before an HTTP failure is recoverable, because the authorization nonce
  was persisted at step 4 and the facilitator can be asked about it afterwards.

## What this document does not claim

It describes version 0.1.1 as installed. The buffering approach means a handler that streams a large
response is fully buffered in memory before settlement, which is a property worth knowing but is not
this phase's concern.

It has not been verified that `processSettlement` is idempotent on the facilitator side for a
repeated identical authorization. The foundation therefore never calls it twice and does not rely on
the answer.
