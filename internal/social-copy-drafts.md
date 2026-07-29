# Social copy drafts: Untch Mail

Drafts. Nothing here is posted automatically, and nothing here should be posted until the inbound
leg of the round trip is confirmed.

Written to `internal/public-copy-standard.md` and checked by `pnpm lint:public-copy`.

## The claim that is safe to make today

> Untch Mail completed an externally funded send. The policy bound the message before payment,
> StableEmail delivered it, and private message content stayed outside the public receipt.

## The claim that becomes safe once the reply lands

> Untch Mail completed an externally funded send and receive flow. The policy bound the message
> before payment, StableEmail delivered it, the reply arrived in an inbox Untch owns, and private
> message content stayed outside the public receipt.

Do not use the second one until `scripts/mail-roundtrip-proof.ts verify` prints
`ROUND_TRIP: CONFIRMED`.

## X, short

> An agent asked to send an email.
>
> Untch checked a policy, funded 0.02 USDC, paid StableEmail on Base, and got a message id back.
>
> The email arrived. The subject it arrived with hashes to the value the intent bound before
> payment.
>
> Receipt: [link]

## X, the part people actually ask about

> "How do you know it was delivered?"
>
> Because the subject hash was fixed before the money moved.
>
> Untch writes the hash onto the intent, pays, and the message lands. Hash the subject that arrived
> and you get the same value. The thing delivered is provably the thing authorised.
>
> The recipient and the body are not in the receipt. Only the hashes are.

## X, on what is not done

> Untch Mail has 9 tools. 3 are LIVE.
>
> 2 are BETA because nothing has settled through them yet.
> 4 say PARTNER_ACCESS_REQUIRED because StableEmail authorises them by owner signature, and Untch
> will not hand its identity key the treasury's key to get a status field.
>
> The registry says which is which.

## YouTube description

Untch Mail is live. An agent proposes an email, a deterministic policy decides whether it is
authorised, Untch funds the exact approved amount, pays StableEmail on Base, and produces one
receipt covering both legs.

This video shows a real send: the policy decision, the 0.02 USDC settlement on Base, the message
arriving, and the subject hash matching the value bound before payment.

What the receipt contains: the settlement amount, chain, recipient and transaction, the fee and
disclosed spread, the policy decision, and the delivery state.

What it does not contain: the recipient address, the subject, or the body.

Base treasury: 0x0e79371813e88F31c2B60C80bad391a952039095
Settlement: 0x9c4570ca2369a296eaaa3d705bfd933059755c8a8ade4946def61d22072f625f

## Words to keep out of all of it

Anything the linter bans.

<!-- copy-lint-disable-next-line naming the banned pattern is the point of this line -->
In particular, do not describe the pack as agentic without naming what the
agent does, and do not imply that receipts are anchored on mainnet. They are durable and currently
unanchored while the writer timelock runs.
