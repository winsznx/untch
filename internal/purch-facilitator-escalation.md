# Purch facilitator: validated payload rejected without diagnostic

Status: **open**. Prepared for Purch. Not sent.

## What happens

`GET https://api.purch.xyz/x402/search?q=usb%20c%20cable` returns a well-formed x402 v2 challenge.
Answering it with a partially-signed Solana transaction returns a bare `402` with the two-byte body
`{}` and no error detail. No settlement occurs and no funds move.

## The challenge, captured raw

Captured 2026-07-29. Full unnormalised fixture at
`internal/evidence/purch/raw/search-402-raw.json`.

| Field | Value |
| --- | --- |
| HTTP status | 402 |
| Challenge carried in | the `payment-required` response header |
| Response body | `{}` (2 bytes) |
| x402Version | 2 |
| scheme | `exact` |
| network | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| asset | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| amount | `10000` (0.01 USDC) |
| payTo | `8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2` |
| extra.feePayer | `BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP` |
| maxTimeoutSeconds | 300 |
| resource.url | `http://api.purch.xyz/x402/search?q=usb%20c%20cable` |

## What was tried

The payload was built by the x402 reference client (`x402@1.2.0`, `exact.svm.createAndSignPayment`):
a v0 versioned transaction, client-supplied blockhash, `transferChecked` with decimals read from the
mint, the sponsor as fee payer, partially signed by the treasury as transfer authority.

Four envelope variants, each a separate fresh challenge:

| Payload `network` | Retry header | Result |
| --- | --- | --- |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `PAYMENT` | 402, empty body |
| `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `X-PAYMENT` | 402, empty body |
| `solana` | `PAYMENT` | 402, empty body |
| `solana` | `X-PAYMENT` | 402, empty body |

The network string is therefore not the differentiator.

**No settlement occurred on any attempt.** The Solana treasury holds 4.769987 USDC and 0.024133914
SOL, unchanged from before the first attempt.

## Two observations worth checking on your side

**1. The client line may be the mismatch.** The payload above was built with `x402@1.2.0`, which is
the v1-era package. Your endpoint serves `x402Version: 2`, and the v2 line ships as
`@x402/core@2.20.0` with `@x402/fetch` and `@x402/svm` on top. Those are different packages rather
than a newer release of the same one, so the v2 envelope may differ from what was sent.

**2. `resource.url` is declared over HTTP.** The challenge names
`http://api.purch.xyz/x402/search?...` while the endpoint is served over HTTPS. If the facilitator
binds the payload to the resource string, a client that normalises to `https` produces something the
verifier will not match.

## What Untch needs answered

1. Which retry header does the verifier read for x402 v2: `PAYMENT`, `X-PAYMENT`,
   `PAYMENT-SIGNATURE`, or another exact name?
2. What is the expected payload envelope? Specifically, is it
   `{scheme, network, x402Version, payload:{transaction}}`, and should `network` echo the CAIP-2 id
   from the challenge or a short form?
3. Is `payTo` the OWNER address or the destination associated token account? The reference client
   derives the destination ATA from `payTo` as an owner.
4. Does the destination token account already exist? The reference client emits no ATA-creation
   instruction, so a missing destination account would produce a transaction the verifier rejects.
5. Is the `http://` scheme in `resource.url` intentional?

## Untch details for correlation

| Item | Value |
| --- | --- |
| Solana treasury (public) | `HsTvSTrXn1HeDzUJTbH4ETXEKTTf2ifEXaQGGEEQ2XUy` |
| Treasury USDC token account | `4C5JJbFTZFRYPM3264mVWu1UqNkC7kos8tWvWfiHrhXo` |
| Cluster | Solana mainnet, genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |

A redacted payload hash can be supplied on request. No secret key, no signed payload and no customer
data appears in this document.

## Draft message

> Hey, we are integrating Purch into Untch's governed Consumer Pack. Your live /x402/search endpoint
> returns a valid Solana challenge, but both the official SVM client path and our validated exact.svm
> client are rejected with a silent 402 before settlement. No funds moved. Could you confirm the x402
> version, required retry header, expected envelope and whether payTo is the owner address or
> destination ATA? I can send the redacted challenge and payload hash.
