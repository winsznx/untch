# The human approval lifecycle

What has to be true before a person's "yes" becomes money that can move.

This is the canonical record for phases 4B through 4E. It follows
[the settlement boundary](./approval-settlement-boundary.md) and
[the x402 lifecycle audit](./x402-settlement-lifecycle.md), which established when a fee is actually
paid and why a pending settlement is not a confirmed one.

## Exact readiness, as of this build

| | |
|---|---|
| Approval foundation | implemented and shadow-proven |
| Web approval binding | **live**, proven end to end |
| Discord link implementation | complete, awaiting first human completion |
| Discord approval | not live-bound yet |
| Telegram link implementation | `CODE_COMPLETE` |
| Telegram callback verification | `AUTOMATED_TEST_PROVEN` |
| Telegram production bot authentication | `BLOCKED` |
| Telegram production account binding | `BLOCKED_BY_PLATFORM_ACCOUNT_ACCESS` |
| Telegram policy approval | `DISABLED` |
| Telegram notification delivery | `DISABLED` for the account-scoped lifecycle |
| Slack | delivery-only, cannot decide, enforced in the schema |
| Human financial approval | shadow-proven, public path disabled |
| `APPROVAL_PATH_READY` | **false** |
| Paid 6.00 and 6.50 proofs | not executed |

Telegram is not a readiness gate. Its implementation stays in the repository with its tests and its
security requirements intact, so a recovered or newly controlled account can complete the genuine flow
later without the approval protocol changing.

## Two scopes, on two different objects

A wallet separates `identity` from `policy-authority`. A channel separates `notify` from
`policy-approval`. Same principle at two levels: being reachable, or being recognisable, is not
permission to spend.

A channel can never hold more authority than the session that created it. An approval-scoped link
requires a wallet carrying `policy-authority`, so an identity-only session cannot launder a weaker
credential into a stronger one.

`can_decide` and the `policy-approval` scope cannot disagree: a database constraint requires the scope
whenever the flag is set, and `PgAccountStore` derives one from the other.

## Channel provenance

Every binding records how it was proven, and the method is never a claim about something that did not
happen.

| Channel | `verification_method` | What actually proves it |
|---|---|---|
| web | `account_session_siwe` | the SIWE signature behind the session, plus a live wallet binding |
| telegram | `telegram_start_callback` | the authenticated `from.id` on the bot's `/start` |
| discord | `discord_oauth_identify` | a server-to-server code exchange reading `/users/@me` |

There is deliberately no `operator_bootstrap_unverified` row in production. Creating one from a chat id
an operator happens to hold would be a binding whose provenance is a guess, and the legacy escalation
configuration is not evidence that an external identity belongs to an account owner.

Re-linking supersedes the old row rather than editing it, so each binding keeps the provenance it was
created with.

## The web surface is a real binding

The tempting shortcut is to let the decision path accept "this came from an authenticated session" and
skip the binding. That gives two authorisation paths, one of which is weaker, and the weaker one is
what gets exploited. So the web actor is an ordinary `untch_channel_bindings` row and `actOnApproval`
cannot tell it apart from Discord: same scope check, same account-ownership check, same can-decide
check, same action token.

Its subject is `web:<accountRefHash>`, which is stable per account and carries no raw account id.

## The link token

A link request creates nothing. No binding, no scope, no delivery target, no approval capability. It
creates a question with an expiry, and only a platform-authenticated callback answers it.

- **Single-use** by `UPDATE ... WHERE status = 'PENDING'` returning a row, not by reading the status
  and then writing it. Two callbacks arriving together both pass a read-then-write.
- **Never stored raw.** The database keeps a fingerprint, because a stored token is redeemable and a
  database dump should not be a way to bind somebody else's Discord to your account.
- **Scope-bound.** A `notify` link cannot come back holding approval authority (`SCOPE_CHANGED`).
- **Account-bound, channel-bound, nonce-bound.**

Refusals: `EXPIRED`, `ALREADY_CONSUMED`, `WRONG_CHANNEL`, `WRONG_ACCOUNT`, `SCOPE_CHANGED`,
`NONCE_CHANGED`, `BAD_SIGNATURE`, `NO_PLATFORM_SUBJECT`, `IDENTITY_BOUND_ELSEWHERE`,
`ACCOUNT_NOT_ACTIVE`, `WALLET_AUTHORITY_INACTIVE`.

Telegram's webhook authenticates twice: the secret header proves the request came from Telegram, and
`from.id` proves who the user is. Neither substitutes for the other. Discord's subject comes from the
code exchange, never from a redirect parameter, which is the entire reason OAuth is used rather than
trusting a query string.

## The action token

Version 1 binds 21 fields: request, digest, intent hash, quote digest, policy id and hash, amount,
asset, chain, recipient, provider, capability, requester ref, wallet authority ref, account ref hash,
channel binding, action, nonce, issued and expiry.

Plain text cannot approve anything. "yes", "approve", "ok", "send it" name no amount, no recipient and
no quote, so an approval built on words authorises whatever the server happens to think the request is
when the words arrive. That is the 6.00-becomes-6.50 failure the digest exists to close.

Every mismatch has its own refusal code, so a caller learns which term moved rather than that
something was invalid: `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `RECIPIENT_MISMATCH`, `QUOTE_MISMATCH`,
`POLICY_MISMATCH`, `REQUESTER_MISMATCH`, `WALLET_AUTHORITY_MISMATCH`, `ACTOR_MISMATCH`,
`DIGEST_MISMATCH`, `WRONG_BINDING`, `WRONG_ACTION`, `EXPIRED`, `BAD_SIGNATURE`.

It carries `accountRefHash` and never a raw `accountId`, because a Discord message should not leak
which Untch account it belongs to.

Single-use is a PRIMARY KEY insert into `untch_approval_action_nonces`, not a flag check. Two
concurrent taps on two channels both pass every check; exactly one wins the insert.

## The terminal decision

A PENDING request reserves nothing. Between being asked and answering, the budget can fill, the policy
can pause, the wallet can be revoked and the quote can be superseded. Approving against the trace that
was true when the request was raised would authorise money against a world that no longer exists.

So the decision path re-reads everything, in one transaction, under the policy's advisory lock:

1. lock the request, verify PENDING
2. verify the service call is FINALIZED, so the fee is confirmed settled
3. verify the channel binding is ACTIVE, belongs to this account, and may decide
4. verify the action token against the live request
5. consume the nonce
6. re-read the policy, the wallet authority and the budget
7. record one decision, create one reservation, invalidate every sibling delivery
8. commit

A changed budget returns `BUDGET_CHANGED_BEFORE_APPROVAL` and creates no APPROVED decision and no
reservation. A second action returns `ALREADY_RESOLVED`. A bootstrap or unverified identity returns
`CHANNEL_BINDING_NOT_VERIFIED_FOR_APPROVAL`.

## The reservation

One `ACTIVE` reservation per approved request, classified `RESERVED_AUTHORITY_NOT_SPEND`.

After a 6.00 approval: `settledGovernedSpend` 0, `activeReservedExposure` 6.00,
`effectiveBudgetUsage` 6.00. No provider execution, no ledger SPEND, no money moved.

`effectiveStatus` is derived rather than stored, so an expired authority stops counting the moment it
expires, whether or not a sweeper has run.

## Quote lineage and supersession

A requote is a successor, and saying so explicitly is what lets the old authority be retired in the
same transaction the new one is created. It has to earn that by naming the exact prior quote: an
unchanged quote is refused, so supersession cannot become a way around the duplicate window.

Supersession atomically marks the prior request `SUPERSEDED`, marks its reservation `SUPERSEDED` so it
stops counting immediately, invalidates its deliveries, and binds old and new bidirectionally. Only
one successor may be open per lineage.

The race it closes: somebody taps Approve on the 6.00 message as the 6.50 arrives. Whichever
transaction takes the request lock first wins. There is no ordering where both take effect.

## The delivery worker

Sends only after the originating transaction has committed. A gateway call inside the decision
transaction would hold database locks across a network round trip and, worse, a rollback would leave a
person having read about a payment that never happened.

Claims with `FOR UPDATE SKIP LOCKED`, one logical delivery per (request, binding), re-checks binding
status and request state at claim time, and retries with backoff without duplicating messages.

## Public and private

`APPROVAL_CASE_PROJECTION` is an allow-list, not a deny-list. A deny-list grows a leak the moment
somebody adds a column, and the column that leaks is always the one nobody thought about.

**Published:** `accountRefHash`, `requesterPrincipalRef`, `walletAuthorityRef`, `serviceCallId`,
settlement transaction hash, policy id and hash, decision id, intent hash, quote digest, amount, asset,
chain, provider, capability, recipient, approval state and digest, channel NAMES, reservation stored
and effective status, `countsTowardExposure`, quote lineage.

**Never published:** raw `accountId`, `walletBindingId`, channel user or chat ids, bearer tokens, link
tokens, action tokens, bot credentials, delivery payloads.

It is named `APPROVAL_CASE_PROJECTION` rather than anything with "Explorer" in it, because Explorer
ingestion does not exist and naming a read model after an unbuilt thing is how a roadmap becomes a
claim.
