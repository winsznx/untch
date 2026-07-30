# Incident: a timelocked operation authorised the wrong account

**Date:** 2026-07-30
**Contract:** UntchReceipts, X Layer mainnet `0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95`
**Impact:** an unintended writer grant; no funds moved, no receipt payload changed, no gas spent on the failed anchor.

## What happened

A timelocked `ADD_WRITER` operation was executed against `0xeeDda7D18A34A93F3A722eb4446A526Af515457A`.
The operation was valid, matured, and matched every value that had been approved and re-verified against
chain immediately beforehand: opId `0x3380bfff…e4b3`, kind `1`, target, eta.

It authorised the wrong account. The service that anchors receipts, `untch-receipt-writer`, signs
`logReceipts` with `0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5` — a different key in a different service.
`0xeeDda7D1…457A` is the ASP's `INTENT_WRITER_PRIVATE_KEY`, the SpendIntentRegistry writer.

Batch 27 was then re-driven and failed with `NotWriter(address)` (`0x5d94d23c`), because the account
attempting the anchor still held no writer role.

## Why it was not caught

Two failures compounded, and both were failures of the QUESTION asked rather than of the answer given.

**The target was never derived.** It came from the ASP's `MAINNET_WRITER_ADDRESS` — a real variable
holding a real address that is genuinely a writer, just not this service's. Nothing in the approval
chain compared it to the key the anchorer actually signs with. Every check asked "is this the operation
that was approved?" and none asked "is the approval about the right account?".

**The board was never enumerated.** The correct operation already existed: `ADD_WRITER` for
`0x03e5abfD…1ab5`, opId `0xb4d6ce98…ddfa`, maturing 2026-07-31T11:46:46Z. It was missed because the
check looked up a single opId — the one for the address it had been handed — rather than listing what
was pending. That maturity timestamp had been supplied in the original brief and was incorrectly
dismissed as not being on chain, on the strength of that same single-opId lookup.

The timelock worked exactly as designed. A 72-hour delay protects against a hasty operation; it cannot
protect against a correct operation about the wrong subject.

## What did not happen

- No transaction was broadcast for the failed anchor. It reverted at gas estimation, so no gas was spent
  and both writer addresses remained at nonce 0.
- No receipt payload changed. Batch 27 still carries `0xac5265d3…08eb29`, kind `DECISION`.
- No USDC moved. The proof wallet holds 0.040000 USDC, unchanged.
- Batches 22–26 were untouched.
- The contract admin was never altered.

## Remaining exposure

`0xeeDda7D1…457A` holds a receipts-writer role it was never intended to have, until `REMOVE_WRITER`
(opId `0x7fa2f2d0…1704`) matures on 2026-08-02T19:13:35Z. The exposure is bounded: writers hold no funds
and authorise no transfer, they can only write into the event log. It nonetheless collapses the
least-privilege separation the contract's own documentation describes, which is why it is being
withdrawn rather than left as a convenience.

## Fixes

**`pnpm gov:identity`** refuses the inputs that produced this. It requires an explicit service, key
variable, expected address, target contract and intended role; derives the signer from the named
service's own key; verifies the signing call path still exists in source; prints current roles on every
registry; enumerates pending operations across a derived candidate set; and refuses when an equivalent
operation is already pending, when the address is already in the intended state, or when the expectation
is the name of an environment variable rather than an address.

Its enumeration covers a candidate set — service signers, role holders, and the named target — not an
exhaustive scan. A Solidity mapping cannot be enumerated on chain and the public RPC caps `getLogs` at
100 blocks. The set necessarily contains the operation missed here, because it contains the receipt
writer's own derived signer, but it is not a proof that no operation exists for an address nobody has
mentioned.

**`pnpm receipt:redrive`** now refuses `--apply` without `--batch <id>`. It previously re-drove every
degraded batch it found; on the day of the incident that would have moved six batches when one was
approved. Reporting stays broad, because seeing the whole picture is the point of a report. Mutation is
narrow, because "which batch" is a decision and a default that answers it will eventually answer wrongly.

## Recovery sequence

1. `ADD_WRITER` for `0x03e5abfD…1ab5` — already pending, matures 2026-07-31T11:46:46Z.
2. Re-drive batch 27 alone and confirm the settlement anchor.
3. Mint and anchor the delivery-verification VERIFY receipt.
4. `REMOVE_WRITER` for `0xeeDda7D1…457A` — matures 2026-08-02T19:13:35Z.

The two operations mature in the opposite order to the ideal sequence. They are independent, so the
addition can be executed first and anchoring restored roughly two days sooner.
