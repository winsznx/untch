import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asset,
  isProviderError,
  money,
  parseMoney,
  type CaipChainId,
  type ConfirmedAsset,
} from "@untch/consumer-core";
import {
  X402EvmExactClient,
  classifyChallenge,
  eip3009DomainFor,
  isBlockedAddress,
  parseChallenge,
  parseWwwAuthenticate,
  renderSiwxMessage,
  selectPayment,
  SiwxSigner,
  X402SolanaExactClient,
  MppTempoClient,
} from "../src/index";

/**
 * Every assertion below runs against REAL 402 responses captured from the live providers on
 * 2026-07-27, not against hand-written approximations of what the spec probably says. If a provider
 * changes its challenge shape, re-running internal/consumer-pack-evidence/probe-paid-endpoints.mjs
 * regenerates this fixture and these tests are what tells us the integration moved underneath us.
 */
const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "live-challenges.json"), "utf8"),
) as Record<string, never>;

const BASE: CaipChainId = "eip155:8453";
const SOLANA: CaipChainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_BASE = asset("base.usdc");

describe("x402 — parsing REAL captured challenges", () => {
  test("StableDomains /api/register offers Base USDC and Solana USDC at $20.00", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    assert.equal(c.x402Version, 2);
    assert.equal(c.accepts.length, 2);
    const base = c.accepts.find((o) => o.network === BASE);
    assert.ok(base, "expected a Base option");
    assert.equal(base.amount, 20_000_000n);
    assert.equal(base.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    assert.equal(base.payTo, "0xABcb091D90419E1c8AD4818f1B33FC4645501892");
    assert.deepEqual(base.extra, { name: "USD Coin", version: "2" });
    const sol = c.accepts.find((o) => o.network === SOLANA);
    assert.ok(sol);
    assert.equal(sol.amount, 20_000_000n);
    assert.equal(sol.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  test("StableEmail /api/send is $0.02 to a different payTo than StableDomains", () => {
    const c = parseChallenge(FIXTURES.stableemailSend402);
    const base = c.accepts.find((o) => o.network === BASE);
    assert.ok(base);
    assert.equal(base.amount, 20_000n);
    assert.equal(base.payTo, "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671");
  });

  test("Purch offers ONLY Solana — there is no Base option to fall back to", () => {
    const c = parseChallenge(FIXTURES.purchSearch402);
    assert.equal(c.accepts.length, 1);
    assert.equal(c.accepts[0]?.network, SOLANA);
    assert.equal(c.accepts[0]?.amount, 10_000n);
    assert.equal(typeof c.accepts[0]?.extra.feePayer, "string");
  });

  test("atomic amounts are parsed as bigint, never as a float", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    assert.equal(typeof c.accepts[0]?.amount, "bigint");
  });
});

describe("x402 — a 402 with an EMPTY accepts[] is SIWX, not a payment failure", () => {
  test("StableDomains /api/domain/dns classifies as siwx", () => {
    const k = classifyChallenge(FIXTURES.stabledomainsDnsSiwx402);
    assert.equal(k.kind, "siwx");
    if (k.kind !== "siwx") return;
    assert.equal(k.request.domain, "stabledomains.dev");
    assert.equal(k.request.chainId, "eip155:8453");
    assert.equal(k.request.type, "eip191");
    assert.equal(k.request.nonce.length, 32);
    assert.ok(k.request.supportedChains.some((c) => c.type === "ed25519"));
  });

  test("StableMerch /api/drafts classifies as siwx", () => {
    const k = classifyChallenge(FIXTURES.stablemerchDraftsSiwx402);
    assert.equal(k.kind, "siwx");
  });

  test("StableDomains /api/register classifies as payment", () => {
    assert.equal(classifyChallenge(FIXTURES.stabledomainsRegister402).kind, "payment");
  });

  test("a null challenge classifies as none rather than throwing", () => {
    assert.equal(classifyChallenge(null).kind, "none");
  });
});

describe("x402 — selection enforces the allowlists before any signer is reached", () => {
  const ctx = (over: Partial<Parameters<typeof selectPayment>[1]> = {}) => ({
    signableChains: new Set<CaipChainId>([BASE]),
    ceilingFor: (): null => null,
    ...over,
  });

  test("a multi-rail challenge selects the rail we can actually sign for", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    const chosen = selectPayment(c, ctx());
    assert.equal(chosen.option.network, BASE);
    assert.equal(chosen.asset.symbol, "USDC");
    assert.equal(chosen.amount.amount, 20_000_000n);
  });

  test("a Solana-only challenge is refused when only Base is signable", () => {
    const c = parseChallenge(FIXTURES.purchSearch402);
    assert.throws(
      () => selectPayment(c, ctx()),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PAYMENT_CHALLENGE_UNACCEPTABLE");
        assert.match(e.normalized.message, /no signing key configured for this rail/);
        return true;
      },
    );
  });

  test("an option whose payTo is not the approved recipient is refused", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    assert.throws(
      () => selectPayment(c, ctx({ allowedRecipients: ["0x000000000000000000000000000000000000dEaD"] })),
      (e: unknown) => {
        assert.ok(isProviderError(e));
        assert.match(e.normalized.message, /not the recipient the approval bound/);
        return true;
      },
    );
  });

  test("an option above the authorised ceiling is refused, not truncated", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    assert.throws(
      () => selectPayment(c, ctx({ ceilingFor: () => parseMoney("10.00", USDC_BASE) })),
      (e: unknown) => {
        assert.ok(isProviderError(e));
        assert.match(e.normalized.message, /exceeds the authorised ceiling/);
        return true;
      },
    );
  });

  test("an asset that is not on the settlement allowlist is refused", () => {
    const c = parseChallenge({
      x402Version: 2,
      resource: { url: "https://evil.test/x", description: "", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: BASE,
          amount: "1000000",
          asset: "0x000000000000000000000000000000000000BEEF",
          payTo: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          maxTimeoutSeconds: 300,
          extra: { name: "Not USDC", version: "1" },
        },
      ],
    });
    assert.throws(
      () => selectPayment(c, ctx()),
      (e: unknown) => {
        assert.ok(isProviderError(e));
        assert.match(e.normalized.message, /not on the settlement allowlist/);
        return true;
      },
    );
  });

  test("a non-'exact' scheme is refused", () => {
    const c = parseChallenge({
      x402Version: 2,
      resource: { url: "https://x.test/y" },
      accepts: [
        {
          scheme: "upto",
          network: BASE,
          amount: "1000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    });
    assert.throws(() => selectPayment(c, ctx()), /scheme 'upto' is not supported/);
  });

  test("the refusal message enumerates why EVERY option was rejected", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    try {
      selectPayment(c, { signableChains: new Set(), ceilingFor: () => null });
      assert.fail("expected a throw");
    } catch (e) {
      assert.ok(isProviderError(e));
      assert.match(e.normalized.message, /eip155:8453/);
      assert.match(e.normalized.message, /solana:/);
    }
  });
});

describe("x402 — the EIP-3009 domain must come from the challenge and match the registry", () => {
  test("a matching domain is accepted", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    const base = c.accepts.find((o) => o.network === BASE);
    assert.ok(base);
    assert.deepEqual(eip3009DomainFor(base, USDC_BASE), { name: "USD Coin", version: "2" });
  });

  test("a MISSING domain is refused rather than guessed", () => {
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    const base = c.accepts.find((o) => o.network === BASE);
    assert.ok(base);
    assert.throws(
      () => eip3009DomainFor({ ...base, extra: {} }, USDC_BASE),
      /did not carry the EIP-3009 domain/,
    );
  });

  test("a domain that CONTRADICTS the registry is refused", () => {
    // A provider swapping the EIP-712 domain out from under a known token would make us sign an
    // authorization valid for something else entirely.
    const c = parseChallenge(FIXTURES.stabledomainsRegister402);
    const base = c.accepts.find((o) => o.network === BASE);
    assert.ok(base);
    assert.throws(
      () => eip3009DomainFor({ ...base, extra: { name: "USD Coin", version: "99" } }, USDC_BASE),
      /does not match the one recorded/,
    );
  });
});

describe("x402 — the EVM exact signer", () => {
  // A fixed key and a fixed nonce make the signature deterministic, so the test asserts an exact
  // value rather than "it produced something".
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const FIXED_NONCE = new Uint8Array(32).fill(7);

  const client = (): X402EvmExactClient =>
    new X402EvmExactClient({
      chain: BASE,
      evmChainId: 8453,
      privateKey: KEY,
      rpcUrl: null,
      clock: () => Date.parse("2026-07-27T12:00:00.000Z"),
      nonceSource: () => FIXED_NONCE,
    });

  test("signing is deterministic for a fixed key, nonce and clock", async () => {
    const challenge = parseChallenge(FIXTURES.stabledomainsRegister402);
    const req = {
      amount: money(20_000_000n, USDC_BASE),
      recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
      challenge: challenge as unknown as Record<string, unknown>,
      resourceUrl: "https://stabledomains.dev/api/register",
      method: "POST",
    };
    const a = await client().pay(req);
    const b = await client().pay(req);
    assert.equal(a.paymentHeader, b.paymentHeader);
    // x402 v2 names this PAYMENT-SIGNATURE; X-PAYMENT is v1 and is sent as an alias so a
    // facilitator that only reads the old name still sees the payment.
    assert.equal(a.headerName, "PAYMENT-SIGNATURE");
    assert.deepEqual(a.aliasHeaderNames, ["X-PAYMENT"]);
  });

  test("the payload carries an EXACT value, recipient, expiry and nonce", async () => {
    const challenge = parseChallenge(FIXTURES.stabledomainsRegister402);
    const res = await client().pay({
      amount: money(20_000_000n, USDC_BASE),
      recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
      challenge: challenge as unknown as Record<string, unknown>,
      resourceUrl: "https://stabledomains.dev/api/register",
      method: "POST",
    });
    const decoded = JSON.parse(Buffer.from(res.paymentHeader, "base64").toString("utf8")) as {
      x402Version: number;
      resource?: { url: string };
      accepted: Record<string, unknown>;
      payload: { signature: string; authorization: Record<string, string> };
      scheme?: unknown;
      network?: unknown;
    };
    // The v2 envelope: scheme and network live inside `accepted`, NOT at the top level. Verified
    // against the installed @okxweb3/x402-core client assembly, not against a spec summary.
    assert.equal(decoded.scheme, undefined, "no top-level scheme — a strict validator may reject it");
    assert.equal(decoded.network, undefined, "no top-level network");
    assert.equal(decoded.accepted.scheme, "exact");
    assert.equal(decoded.accepted.network, BASE);
    assert.equal(decoded.accepted.amount, "20000000");
    assert.deepEqual(decoded.accepted.extra, { name: "USD Coin", version: "2" });
    // `resource` is echoed back so a facilitator can bind the payment to what it was issued for.
    assert.equal(typeof decoded.resource?.url, "string");
    assert.equal(decoded.payload.authorization.value, "20000000");
    assert.equal(decoded.payload.authorization.to, "0xABcb091D90419E1c8AD4818f1B33FC4645501892");
    // An expiry exists and is bounded — a captured authorization goes stale on its own.
    assert.ok(Number(decoded.payload.authorization.validBefore) > 1_700_000_000);
    // validAfter is now-5, matching the reference client: five seconds of slack for clock skew,
    // because USDC requires block.timestamp > validAfter and equality loses that race.
    const va = Number(decoded.payload.authorization.validAfter);
    assert.ok(va > 0 && va < Number(decoded.payload.authorization.validBefore));
    assert.equal(decoded.payload.authorization.nonce, `0x${"07".repeat(32)}`);
    assert.match(decoded.payload.signature, /^0x[0-9a-f]{130}$/);
  });

  test("txHash is NULL — this scheme does not broadcast, so a hash would be invented", async () => {
    const challenge = parseChallenge(FIXTURES.stabledomainsRegister402);
    const res = await client().pay({
      amount: money(20_000_000n, USDC_BASE),
      recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
      challenge: challenge as unknown as Record<string, unknown>,
      resourceUrl: "https://stabledomains.dev/api/register",
      method: "POST",
    });
    assert.equal(res.txHash, null);
  });

  test("signing is REFUSED when the challenge does not offer that amount to that recipient", async () => {
    // The capability already checked the amount against what was AUTHORISED. This checks it against
    // what the provider is asking for right now. Both must agree, and the refusal now happens inside
    // the SHARED selector — so it is caught one step earlier than before, as PAYMENT_CHALLENGE_
    // UNACCEPTABLE rather than PAYMENT_BINDING_MISMATCH. Either is a refusal; what matters is that
    // nothing is signed.
    const challenge = parseChallenge(FIXTURES.stabledomainsRegister402);
    await assert.rejects(
      () =>
        client().pay({
          amount: money(19_000_000n, USDC_BASE),
          recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          challenge: challenge as unknown as Record<string, unknown>,
          resourceUrl: "https://stabledomains.dev/api/register",
          method: "POST",
        }),
      (e: unknown) => {
        assert.ok(isProviderError(e));
        assert.ok(
          e.normalized.code === "PAYMENT_CHALLENGE_UNACCEPTABLE" ||
            e.normalized.code === "PAYMENT_BINDING_MISMATCH",
          `unexpected code ${e.normalized.code}`,
        );
        return true;
      },
    );
  });

  test("a DECOY option cannot hijack the signature — one selector decides, not two", async () => {
    // The attack: a provider puts a decoy FIRST carrying the same amount and payTo but a different
    // asset. A signer that re-scans accepts[] for "amount + recipient match" binds the authorization
    // to the decoy's token while every upstream allowlist check passed against the real entry.
    const decoyed = parseChallenge({
      x402Version: 2,
      resource: { url: "https://stabledomains.dev/api/register" },
      accepts: [
        {
          scheme: "exact",
          network: BASE,
          amount: "20000000",
          asset: "0x000000000000000000000000000000000000BEEF",
          payTo: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          maxTimeoutSeconds: 300,
          extra: { name: "Not USDC", version: "1" },
        },
        {
          scheme: "exact",
          network: BASE,
          amount: "20000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    });
    const res = await client().pay({
      amount: money(20_000_000n, USDC_BASE),
      recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
      challenge: decoyed as unknown as Record<string, unknown>,
      resourceUrl: "https://stabledomains.dev/api/register",
      method: "POST",
    });
    const decoded = JSON.parse(Buffer.from(res.paymentHeader, "base64").toString("utf8")) as {
      accepted: Record<string, unknown>;
    };
    // The decoy is at index 0. The allowlisted USDC entry must be the one paid.
    assert.equal(decoded.accepted.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    assert.deepEqual(decoded.accepted.extra, { name: "USD Coin", version: "2" });
  });

  test("a client with no key reports unavailable and refuses to pay", async () => {
    const noKey = new X402EvmExactClient({ chain: BASE, evmChainId: 8453, privateKey: null, rpcUrl: null });
    assert.equal(noKey.available(), false);
    await assert.rejects(
      () =>
        noKey.pay({
          amount: money(1n, USDC_BASE),
          recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          challenge: {},
          resourceUrl: "https://x.test/y",
          method: "POST",
        }),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "TREASURY_INSUFFICIENT");
        return true;
      },
    );
  });
});

describe("rails that are honestly not executable", () => {
  test("the Solana rail reports unavailable with a key but no arm switch, and refuses to pay", async () => {
    // The rail is executable now, so the refusal reason changed. What did NOT change is the rule the
    // original test was written to protect: a key existing is not permission. `available()` gates
    // capability minting, and reporting true on the strength of a key alone would let an intent
    // reach PROVIDER_PAYMENT_PENDING before anyone decided it should, which is the one transition
    // that costs a manual review.
    const c = new X402SolanaExactClient({ chain: SOLANA, secretKey: "a-real-looking-key", rpcUrl: null });
    assert.equal(c.available(), false);
    await assert.rejects(
      () =>
        c.pay({
          amount: money(1n, asset("solana.usdc")),
          recipient: "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2",
          challenge: {},
          resourceUrl: "https://api.purch.xyz/x402/search",
          method: "GET",
        }),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_NOT_EXECUTABLE");
        assert.match(e.normalized.message, /not armed on this instance/);
        return true;
      },
    );
  });

  test("the Tempo/MPP rail refuses with the reason its currency is unconfirmed", async () => {
    const c = new MppTempoClient({ chain: "eip155:4217" });
    assert.equal(c.available(), false);
    await assert.rejects(
      () =>
        c.pay({
          amount: money(1n, USDC_BASE),
          recipient: "0xABcb091D90419E1c8AD4818f1B33FC4645501892",
          challenge: {},
          resourceUrl: "https://x.test/y",
          method: "POST",
        }),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PROTOCOL_NOT_EXECUTABLE");
        assert.match(e.normalized.message, /decimals are unknown/);
        return true;
      },
    );
  });
});

describe("MPP — parsing the REAL WWW-Authenticate header", () => {
  test("StableDomains' MPP challenge decodes to a Tempo charge", () => {
    const raw = (FIXTURES.mppWwwAuthenticate as unknown as Record<string, string>).stabledomainsDns;
    const parsed = parseWwwAuthenticate(raw);
    assert.ok(parsed);
    assert.equal(parsed.method, "tempo");
    assert.equal(parsed.intent, "charge");
    assert.equal(parsed.realm, "stabledomains.dev");
    assert.ok(parsed.request);
    assert.equal(parsed.request.chainId, 4217);
    assert.equal(parsed.request.currency, "0x20c000000000000000000000b9537d11c60e8b50");
    assert.equal(parsed.request.recipient, "0xABcb091D90419E1c8AD4818f1B33FC4645501892");
  });

  test("a non-Payment WWW-Authenticate is ignored rather than misparsed", () => {
    assert.equal(parseWwwAuthenticate('Bearer realm="x"'), null);
    assert.equal(parseWwwAuthenticate(undefined), null);
  });

  test("a quoted value containing a comma survives parsing", () => {
    const parsed = parseWwwAuthenticate('Payment id="a,b", realm="x.test", method="tempo"');
    assert.equal(parsed?.id, "a,b");
    assert.equal(parsed?.realm, "x.test");
    assert.equal(parsed?.method, "tempo");
  });

  test("an undecodable request payload yields null rather than a bogus charge", () => {
    const parsed = parseWwwAuthenticate('Payment id="x", method="tempo", request="not-base64-json"');
    assert.equal(parsed?.request, null);
  });
});

describe("SIWX — the message rendering is EIP-4361, asserted against a golden string", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

  test("renders the canonical EIP-4361 layout", () => {
    const k = classifyChallenge(FIXTURES.stabledomainsDnsSiwx402);
    assert.equal(k.kind, "siwx");
    if (k.kind !== "siwx") return;
    const msg = renderSiwxMessage(k.request, "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    const lines = msg.split("\n");
    assert.equal(lines[0], "stabledomains.dev wants you to sign in with your account:");
    assert.equal(lines[1], "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    assert.equal(lines[2], "");
    assert.equal(lines[3], "Sign in to verify your wallet identity");
    assert.equal(lines[4], "");
    assert.ok(lines.some((l) => l.startsWith("URI: https://stabledomains.dev/api/domain/dns")));
    assert.ok(lines.some((l) => l === "Version: 1"));
    assert.ok(lines.some((l) => l === "Chain ID: eip155:8453"));
    assert.ok(lines.some((l) => l.startsWith("Nonce: ")));
    assert.ok(lines.some((l) => l.startsWith("Issued At: ")));
    assert.ok(lines.some((l) => l.startsWith("Expiration Time: ")));
  });

  test("signing produces a base64 SIGN-IN-WITH-X credential with the signer's address", async () => {
    const k = classifyChallenge(FIXTURES.stabledomainsDnsSiwx402);
    if (k.kind !== "siwx") return assert.fail("expected siwx");
    const signer = new SiwxSigner({ privateKey: KEY, clock: () => Date.parse("2026-07-27T17:15:00.000Z") });
    const cred = await signer.sign(k.request);
    assert.equal(cred.headerName, "SIGN-IN-WITH-X");
    const decoded = JSON.parse(Buffer.from(cred.headerValue, "base64").toString("utf8")) as Record<string, string>;
    assert.equal(decoded.address, signer.address());
    assert.equal(decoded.nonce, k.request.nonce);
    assert.match(decoded.signature ?? "", /^0x[0-9a-f]{130}$/);
  });

  test("an EXPIRED challenge is refused rather than signed", async () => {
    const k = classifyChallenge(FIXTURES.stabledomainsDnsSiwx402);
    if (k.kind !== "siwx") return assert.fail("expected siwx");
    const signer = new SiwxSigner({ privateKey: KEY, clock: () => Date.parse("2027-01-01T00:00:00.000Z") });
    await assert.rejects(() => signer.sign(k.request), (e: unknown) => {
      assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_UNAUTHORIZED");
      return true;
    });
  });

  test("an ed25519 (Solana) challenge is refused — this build signs eip191 only", async () => {
    const k = classifyChallenge(FIXTURES.stabledomainsDnsSiwx402);
    if (k.kind !== "siwx") return assert.fail("expected siwx");
    const signer = new SiwxSigner({ privateKey: KEY, clock: () => Date.parse("2026-07-27T17:15:00.000Z") });
    await assert.rejects(() => signer.sign({ ...k.request, type: "ed25519" }), /not supported/);
  });

  test("with no key configured, SIWX reports unauthorized rather than a fake success", async () => {
    const k = classifyChallenge(FIXTURES.stabledomainsDnsSiwx402);
    if (k.kind !== "siwx") return assert.fail("expected siwx");
    const signer = new SiwxSigner({ privateKey: null });
    assert.equal(signer.available(), false);
    await assert.rejects(() => signer.sign(k.request), /no CONSUMER_SIWX_PRIVATE_KEY/);
  });
});

describe("SSRF — the address blocklist", () => {
  test("blocks loopback, RFC1918, link-local (incl. cloud metadata), CGNAT and multicast", () => {
    for (const ip of [
      "127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1",
      "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
    ]) {
      assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "104.18.0.1", "172.32.0.1", "2606:4700::1111"]) {
      assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
    }
  });

  test("a non-IP string is blocked rather than assumed safe", () => {
    assert.equal(isBlockedAddress("not-an-ip"), true);
    assert.equal(isBlockedAddress(""), true);
  });
});
