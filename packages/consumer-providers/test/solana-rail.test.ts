/**
 * The Solana rail's refusal matrix.
 *
 * Every test here asserts the same underlying property from a different angle: THE SIGNER IS NEVER
 * REACHED unless every static guard has passed. That is stated once, in `neverSigned`, and then
 * checked on every refusal path, because the thing that makes this rail different from an EVM one is
 * that its output is a transaction a THIRD PARTY submits. A signature produced during a rejected
 * payment is not a wasted computation, it is a spendable artifact sitting in a sponsor's hands.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asset, isProviderError, money, type PaymentRequest } from "@untch/consumer-core";
import {
  X402SolanaExactClient,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MIN_LAMPORTS,
  isSolanaMainnet,
  selectSolanaOption,
  type DecodedTransfer,
  type V2Credential,
  type V2CredentialInput,
} from "../src/index";

const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "live-challenges.json"), "utf8"),
) as Record<string, Record<string, unknown>>;

const USDC_SOL = asset("solana.usdc");
const PURCH_PAYTO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A well-formed 64-byte keypair. Not a real treasury, and it never gets used in a refusal test. */
const KEYPAIR =
  "3J2ELDreLNCg7bXTKKPzXcnQxkKQPHy6mcTRJvBBgtdLDhc7qMSVAopeoUJhCTMEfNv5Yrq3KKhFuqxSFYRYcJML";
const NOW = Date.parse("2026-07-29T18:00:00.000Z");

/** A builder that fails the test if it is ever called. */
function neverSigned(): (input: V2CredentialInput) => Promise<V2Credential> {
  return async () => {
    assert.fail("the payload builder was reached on a payment that should have been refused");
  };
}

function recordingBuilder(): {
  build: (input: V2CredentialInput) => Promise<V2Credential>;
  calls: V2CredentialInput[];
} {
  const calls: V2CredentialInput[] = [];
  return {
    calls,
    build: async (input) => {
      calls.push(input);
      return {
        // The official client returns an OPAQUE credential. The test stands in for one rather than
        // reproducing its internals, because reproducing them is exactly what went wrong before.
        headers: { "PAYMENT-SIGNATURE": "b3BhcXVlLXYyLWNyZWRlbnRpYWw" },
        wireTransaction: "AQAAfakewiretransaction",
        declared: { scheme: "exact", network: input.network, x402Version: 2 },
      };
    },
  };
}

/** A decoder that reports a transfer matching the live fixture unless a test overrides it. */
const matchingDecoder = (over: Partial<DecodedTransfer> = {}) => async (): Promise<DecodedTransfer> => ({
  amount: 10_000n,
  mint: USDC_MINT,
  feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP",
  signerCount: 1,
  hasBlockhash: true,
  programIds: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
  ...over,
});

function client(
  over: Partial<ConstructorParameters<typeof X402SolanaExactClient>[0]> = {},
): X402SolanaExactClient {
  return new X402SolanaExactClient({
    chain: SOLANA_MAINNET_CAIP2 as never,
    secretKey: KEYPAIR,
    rpcUrl: "https://rpc.test",
    executionEnabled: true,
    lamportReader: async () => 24_133_914n,
    credentialBuilder: neverSigned(),
    transferDecoder: matchingDecoder(),
    clock: () => NOW,
    ...over,
  });
}

/** Deep-clone the live challenge so a test can alter exactly one field. */
function challenge(mutate: (option: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(FIXTURES.purchSearch402)) as Record<string, unknown>;
  const option = selectSolanaOption(c);
  assert.ok(option, "the fixture must carry a Solana option");
  mutate(option);
  return c;
}

const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  amount: money(10_000n, USDC_SOL),
  recipient: PURCH_PAYTO,
  challenge: challenge(),
  resourceUrl: "https://api.purch.xyz/x402/search",
  method: "GET",
  ...over,
});

async function refuses(c: X402SolanaExactClient, req: PaymentRequest, why: RegExp): Promise<void> {
  await assert.rejects(
    () => c.pay(req),
    (e: unknown) => {
      assert.ok(isProviderError(e), `expected a typed ProviderError, got ${String(e)}`);
      assert.match(e.normalized.message, why);
      return true;
    },
  );
}

describe("Solana rail — the cluster", () => {
  test("Solana mainnet is accepted, in both CAIP-2 spellings", () => {
    // CAIP-2 caps a reference at 32 characters, but some providers send the full 44-character
    // genesis hash. Both name the same cluster.
    assert.equal(isSolanaMainnet("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), true);
    assert.equal(isSolanaMainnet("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"), true);
  });

  test("devnet, testnet and a truncated impostor are all refused", () => {
    assert.equal(isSolanaMainnet("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), false, "devnet");
    assert.equal(isSolanaMainnet("solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"), false, "testnet");
    // A prefix short enough to be ambiguous must not pass just because it matches the start.
    assert.equal(isSolanaMainnet("solana:5eykt4Us"), false);
    assert.equal(isSolanaMainnet("eip155:8453"), false);
  });

  test("a challenge on the wrong cluster never reaches the signer", async () => {
    await refuses(
      client(),
      request({ challenge: challenge((o) => { o.network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; }) }),
      /not Solana mainnet/,
    );
  });
});

describe("Solana rail — what the challenge must say", () => {
  test("the canonical USDC mint is required, and a lookalike is refused", async () => {
    await refuses(
      client(),
      request({ challenge: challenge((o) => { o.asset = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1u"; }) }),
      /is not on the settlement allowlist/,
    );
  });

  test("an unallowlisted recipient is refused", async () => {
    await refuses(
      client(),
      request({
        challenge: challenge((o) => { o.payTo = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"; }),
        recipient: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      }),
      /not on the Solana recipient allowlist/,
    );
  });

  test("a challenge with no sponsor is refused rather than silently self-funded", async () => {
    // Without extra.feePayer the treasury would pay the network fee itself. That is a different
    // transaction with different SOL requirements, so it is a refusal and not a fallback.
    await refuses(
      client(),
      request({ challenge: challenge((o) => { o.extra = {}; }) }),
      /names no extra\.feePayer/,
    );
  });

  test("a scheme other than 'exact' is refused", async () => {
    await refuses(client(), request({ challenge: challenge((o) => { o.scheme = "upto"; }) }), /is not 'exact'/);
  });

  test("a non-atomic amount is refused", async () => {
    await refuses(client(), request({ challenge: challenge((o) => { o.amount = "0.01"; }) }), /not an atomic integer/);
  });

  test("a challenge with no Solana option at all is refused", async () => {
    await refuses(
      client(),
      request({ challenge: { accepts: [{ network: "eip155:8453", scheme: "exact" }] } }),
      /carries no Solana option/,
    );
  });
});

describe("Solana rail — the authorised figure and the asked figure must agree", () => {
  test("an amount altered between selection and signing is refused, not reconciled", async () => {
    // #given a challenge asking 10000 but an authorisation for 9999
    // #then neither figure is paid, because one of them is wrong and we cannot tell which
    await refuses(client(), request({ amount: money(9_999n, USDC_SOL) }), /Refusing rather than paying either figure/);
  });

  test("an amount altered upward is refused just as firmly", async () => {
    await refuses(client(), request({ amount: money(50_000n, USDC_SOL) }), /Refusing rather than paying either figure/);
  });

  test("a recipient altered between selection and signing is refused", async () => {
    await refuses(
      client(),
      request({ recipient: "HvBMG7ezcwDssxXP7DPJJsveyDnvUm2wNySBR5WF2XEY" }),
      /but this payment was authorised for/,
    );
  });
});

describe("Solana rail — the arm switches", () => {
  test("execution disabled refuses, whatever else is configured", async () => {
    await refuses(client({ executionEnabled: false }), request(), /not armed on this instance/);
  });

  test("an unarmed rail is not even selectable", () => {
    // available() decides whether the treasury router mints a capability at all. A merely CAPABLE
    // rail must not be selectable, or an intent reaches PROVIDER_PAYMENT_PENDING before anyone
    // decided it should.
    assert.equal(client({ executionEnabled: false }).available(), false);
    assert.equal(client({ secretKey: null }).available(), false);
    assert.equal(client({ rpcUrl: null }).available(), false);
    assert.equal(client().available(), true);
  });

  test("a rail with no key refuses before touching the challenge", async () => {
    await refuses(client({ secretKey: null }), request(), /no Solana signing key configured/);
  });

  test("a rail with no RPC refuses", async () => {
    await refuses(client({ rpcUrl: null }), request(), /CONSUMER_SOLANA_RPC_URL is not set/);
  });

  test("monitoring stays possible on a rail that cannot spend", () => {
    // Reading a float and spending from it are different permissions, and an operator watching an
    // unarmed treasury is the normal case rather than an edge one.
    const unarmed = client({ executionEnabled: false });
    assert.equal(unarmed.available(), false);
    assert.equal(unarmed.readable(), true);
  });
});

describe("Solana rail — staleness and float", () => {
  test("a challenge past its own window is refused before signing", async () => {
    // A Solana blockhash lives about 60 seconds. Signing against a dead one produces a transaction
    // the sponsor cannot land, which surfaces as a confusing provider-side failure.
    await refuses(
      client(),
      request({
        challenge: challenge((o) => {
          o.issuedAt = new Date(NOW - 400_000).toISOString();
          o.maxTimeoutSeconds = 300;
        }),
      }),
      /past its 300s window/,
    );
  });

  test("a challenge inside its window proceeds", async () => {
    const rec = recordingBuilder();
    await client({ credentialBuilder: rec.build }).pay(
      request({
        challenge: challenge((o) => {
          o.issuedAt = new Date(NOW - 10_000).toISOString();
          o.maxTimeoutSeconds = 300;
        }),
      }),
    );
    assert.equal(rec.calls.length, 1);
  });

  test("a treasury under the rent reserve is refused", async () => {
    // Sponsored transfers need no gas, so this is not a gas check. It is rent-exemption on the
    // treasury's own token account, which is what stops the float being reclaimed.
    await refuses(
      client({ lamportReader: async () => SOLANA_MIN_LAMPORTS - 1n }),
      request(),
      /under the .* rent reserve/,
    );
  });

  test("an unreadable SOL balance does not block a payment", async () => {
    // An RPC hiccup on a monitoring read must not become a payment failure. The reserve check is a
    // safety net, and a net that fails closed on every network blip would stop the product working.
    const rec = recordingBuilder();
    await client({
      lamportReader: async () => { throw new Error("rpc timeout"); },
      credentialBuilder: rec.build,
    }).pay(request());
    assert.equal(rec.calls.length, 1);
  });
});

describe("Solana rail — the payload it hands back", () => {
  test("the credential is forwarded OPAQUE, never re-wrapped", async () => {
    // The whole defect this replaced was Untch re-encoding the credential into its own envelope.
    // The header value must be exactly what the official client produced, byte for byte.
    const rec = recordingBuilder();
    const result = await client({ credentialBuilder: rec.build }).pay(request());
    assert.equal(result.paymentHeader, "b3BhcXVlLXYyLWNyZWRlbnRpYWw");

    // Specifically NOT our old shape. If this ever parses as that JSON again, the bug is back.
    let reWrapped = false;
    try {
      const j = JSON.parse(Buffer.from(result.paymentHeader, "base64").toString("utf8")) as Record<string, unknown>;
      reWrapped = typeof j.scheme === "string" && typeof j.x402Version === "number";
    } catch {
      // Not JSON, which is what an opaque credential should look like.
    }
    assert.equal(reWrapped, false, "the credential was re-wrapped in the legacy v1 envelope");
  });

  test("the builder is pinned to the option the guards validated", async () => {
    // Without pinning, the official client may select any entry in accepts[], including one whose
    // mint and recipient were never checked.
    const rec = recordingBuilder();
    await client({ credentialBuilder: rec.build }).pay(request());
    assert.equal(rec.calls[0]?.network, SOLANA_MAINNET_CAIP2);
    assert.equal(rec.calls[0]?.rawChallenge !== undefined, true, "the RAW challenge is passed, not a normalised copy");
  });

  test("a transaction that does not match the authorised challenge is refused", async () => {
    // The official client is a serializer. Hand it a wrong requirement and it encodes that wrong
    // requirement faithfully, so the bytes are read back and compared.
    const rec = recordingBuilder();
    await refuses(
      client({ credentialBuilder: rec.build, transferDecoder: matchingDecoder({ amount: 50_000n }) }),
      request(),
      /transfers 50000 but the challenge asked 10000/,
    );
    await refuses(
      client({ credentialBuilder: rec.build, transferDecoder: matchingDecoder({ mint: "So11111111111111111111111111111111111111112" }) }),
      request(),
      /not the validated mint/,
    );
    await refuses(
      client({ credentialBuilder: rec.build, transferDecoder: matchingDecoder({ feePayer: "HsTvSTrXn1HeDzUJTbH4ETXEKTTf2ifEXaQGGEEQ2XUy" }) }),
      request(),
      /not the sponsor/,
    );
    await refuses(
      client({ credentialBuilder: rec.build, transferDecoder: matchingDecoder({ hasBlockhash: false }) }),
      request(),
      /carries no blockhash/,
    );
  });

  test("a client that returns X-PAYMENT for a v2 challenge is refused", async () => {
    const mixing = async (): Promise<V2Credential> => ({
      headers: { "PAYMENT-SIGNATURE": "abc", "X-PAYMENT": "abc" },
      wireTransaction: "AQAA",
      declared: { scheme: "exact", network: SOLANA_MAINNET_CAIP2, x402Version: 2 },
    });
    await refuses(client({ credentialBuilder: mixing }), request(), /Refusing to mix protocol versions/);
  });

  test("a client that produces no credential or no transaction is refused", async () => {
    const noHeader = async (): Promise<V2Credential> => ({
      headers: {},
      wireTransaction: "AQAA",
      declared: { scheme: "exact", network: SOLANA_MAINNET_CAIP2, x402Version: 2 },
    });
    await refuses(client({ credentialBuilder: noHeader }), request(), /produced no PAYMENT-SIGNATURE header/);
  });

  test("a credential declaring the wrong protocol version is refused", async () => {
    const v1 = async (): Promise<V2Credential> => ({
      headers: { "PAYMENT-SIGNATURE": "abc" },
      wireTransaction: "AQAA",
      declared: { scheme: "exact", network: SOLANA_MAINNET_CAIP2, x402Version: 1 },
    });
    await refuses(client({ credentialBuilder: v1 }), request(), /declared x402Version 1 for a v2 challenge/);
  });

  test("no transaction hash is invented at signing time", async () => {
    // The sponsor submits, so this wallet never learns the signature here. A synthesised hash would
    // put a value in the ledger that no explorer can resolve.
    const rec = recordingBuilder();
    const result = await client({ credentialBuilder: rec.build }).pay(request());
    assert.equal(result.txHash, null);
    // Settled by observation, not by reading a spec. PAYMENT and X-PAYMENT both drew a bare 402
    // from Purch; its own documented v2 client used `payment-signature` and got a 200 first try.
    assert.equal(result.headerName, "PAYMENT-SIGNATURE");
    // No alias. Two payment headers on one request invites a verifier to read the wrong one.
    assert.equal(result.aliasHeaderNames, undefined);
  });

  test("the secret never appears in the returned result", async () => {
    const rec = recordingBuilder();
    const result = await client({ credentialBuilder: rec.build }).pay(request());
    assert.ok(!JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)).includes(KEYPAIR));
  });
});

describe("Solana rail — reading the float", () => {
  test("a missing token account reads as zero, not as a failure", async () => {
    // An unfunded treasury genuinely holds nothing. Reporting that as an error would make it
    // indistinguishable from a broken rail.
    const c = client({ balanceReader: async () => 0n });
    assert.equal((await c.balanceOf(USDC_SOL)).amount, 0n);
  });

  test("the address is derived from the keypair without a signing library", () => {
    const derived = client().address();
    assert.match(derived, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // Deriving twice must be stable, since the value is cached after the first call.
    assert.equal(derived, client().address());
  });
});

describe("Solana rail — the two challenge shapes", () => {
  test("a NORMALIZED challenge, whose amount is a bigint, is accepted", async () => {
    // The transport passes X402Challenge, not the raw decoded JSON, and its options carry `amount`
    // as a bigint. A string-only reader saw that as absent and refused a valid challenge. The
    // refusal was safe, and it was still a bug on our side.
    const rec = recordingBuilder();
    await client({ credentialBuilder: rec.build }).pay(
      request({
        challenge: {
          accepts: [{
            scheme: "exact",
            network: SOLANA_MAINNET_CAIP2,
            amount: 10_000n,
            asset: USDC_MINT,
            payTo: PURCH_PAYTO,
            maxTimeoutSeconds: 300,
            extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP" },
          }],
        },
      }),
    );
    assert.equal(rec.calls.length, 1);
  });

  test("a RAW challenge, whose amount is a decimal string, is accepted", async () => {
    const rec = recordingBuilder();
    await client({ credentialBuilder: rec.build }).pay(request());
    assert.equal(rec.calls.length, 1);
  });

  test("a FLOAT amount is still refused, in either shape", async () => {
    // 19.99 where an atomic amount belongs is a factor-of-a-million mistake waiting to happen.
    await refuses(client(), request({ challenge: challenge((o) => { o.amount = 0.01; }) }), /not an atomic integer/);
    await refuses(client(), request({ challenge: challenge((o) => { o.amount = "19.99"; }) }), /not an atomic integer/);
  });
});
