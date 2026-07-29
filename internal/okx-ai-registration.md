# OKX.AI registration draft: Untch Mail

Draft, not submitted. Every state below is the state the live registry reports at
`https://asp.untch.xyz/consumer/catalog`, and it is generated from durable rows rather than written
by hand.

Written to the rules in `internal/public-copy-standard.md` and checked by `pnpm lint:public-copy`.

## Service family

**Untch Mail.** An agent asks to send an email or own a mailbox. Untch checks a deterministic policy,
funds the exact approved amount, pays StableEmail on Base, verifies what it can verify, and produces
one receipt. The recipient and the message body never enter the receipt.

ASP #6086. Settlement rail for the provider leg is Base USDC. The caller-facing fee leg is USDT0 on
X Layer.

## Tools

| Tool | Route | Untch fee | Provider price | State |
| --- | --- | --- | --- | --- |
| `mail.send` | `POST /consumer/mail/send` | $0.05 | $0.02 | **LIVE** |
| `mail.inbox.buy` | `POST /consumer/mail/inbox/buy` | $0.05 | $1.00 / 30 days | **LIVE** |
| `mail.inbox.messages` | `POST /consumer/mail/inbox/messages` | $0.02 | $0.001 | **LIVE** |
| `mail.inbox.topup` | `POST /consumer/mail/inbox/topup` | $0.05 | $1.00 / $2.50 / $8.00 | BETA |
| `mail.subdomain.buy` | `POST /consumer/mail/subdomain/buy` | $0.05 | $5.00 | BETA |
| `mail.inbox.status` | `POST /consumer/mail/inbox/status` | $0.02 | free | PARTNER_ACCESS_REQUIRED |
| `mail.inbox.cancel` | `POST /consumer/mail/inbox/cancel` | $0.05 | free | PARTNER_ACCESS_REQUIRED |
| `mail.subdomain.status` | `POST /consumer/mail/subdomain/status` | $0.02 | free | PARTNER_ACCESS_REQUIRED |
| `mail.subdomain.send` | `POST /consumer/mail/subdomain/send` | $0.05 | $0.005 | PARTNER_ACCESS_REQUIRED |

The provider price is never read from this table at runtime. It comes from StableEmail's own 402,
seconds before a caller is asked to approve it.

## Why four tools are PARTNER_ACCESS_REQUIRED

Three of them are SIWX-gated and owner-scoped. StableEmail authorises them by owner **signature**,
and the wallet that owns Untch's inbox is the Base settlement treasury. Satisfying that would mean
giving the SIWX identity key the treasury's key, turning a powerless identity into a spending key so
that a leaked signer could drain the float. Untch will not make that trade for a status field.

`mail.subdomain.send` needs a subdomain Untch does not own.

`mail.inbox.messages` reads the same inbox by **payer**, which the treasury already is, and that is
the route Untch uses instead.

## Authentication

SIWE over a server-issued, single-use, expiring nonce, verified against the policy's on-chain owner.
A policy id alone is namespacing, not authorisation.

## Approval behaviour

Every paid route quotes. None settles inline. `POST /consumer/mail/execute` is the only door that
spends, and it takes an intent that has already been quoted, policy-checked and funded. An approval
binds to a `quoteHash`, and changing the amount, the recipient or the message body changes the hash.

## Live evidence

| Fact | Value |
| --- | --- |
| First send settled | `0x9c4570ca2369a296eaaa3d705bfd933059755c8a8ade4946def61d22072f625f` (Base 49273744) |
| Inbox purchased | `0x437ddc66044f9f5251630bbb4f017cac48bade6e8fdf17b9efa4ef0f6f752b6f` (Base 49274815) |
| Externally funded intent | `0x212ca57d6a07aa6630edd9a16fe02c90dcd03b4f3656e6dea1c5d97e65015bcd` on X Layer |
| Treasury | `0x0e79371813e88F31c2B60C80bad391a952039095` |
| Receipts | `0x66edaae2…9774f`, `0xe259df23…12fe`, `0x68503be1…99ef` |

## Receipt example

`GET https://asp.untch.xyz/consumer/receipt/ci_8225f9800c3434582a235fcf`

Carries the settlement amount, chain, recipient and transaction, the Untch fee and disclosed spread,
the policy id and decision, the delivery state, and the receipt's own anchor status. It carries no
recipient address, no subject and no body.

## What must not be claimed

- That every Mail tool is LIVE. Four are not.
- That inbox cancellation is proven. It has never been run.
- That subdomains are LIVE. None has been bought.
- That mainnet receipt anchoring is complete. Receipts are durable and currently report
  `DEGRADED_UNANCHORED` while the X Layer writer serves its three-day timelock.
- That message privacy uses encryption. It does not. Private fields are **excluded** from the public
  receipt and represented by SHA-256 hashes. That is exclusion and hashing, not encryption.
