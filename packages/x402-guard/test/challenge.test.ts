import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChallengeParseError,
  bindingFromChallenge,
  decodePaymentRequiredHeader,
  parseChallenge,
} from "../src/challenge";

/** A real-shaped x402 challenge (matches the captured D0.1 402-challenge.json). */
const REAL_CHALLENGE = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://untch-asp-production.up.railway.app/preflight_payment",
    description: "Untch preflight",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:196",
      amount: "50000",
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      payTo: "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b",
      maxTimeoutSeconds: 300,
      extra: { name: "USD₮0", version: "1" },
    },
  ],
};

test("parseChallenge extracts the exact-scheme accepts entry", () => {
  const p = parseChallenge(REAL_CHALLENGE);
  assert.equal(p.scheme, "exact");
  assert.equal(p.network, "eip155:196");
  assert.equal(p.amount, "50000");
  assert.equal(p.token, "0x779ded0c9e1022225f8e0630b35a9b54be713736");
  assert.equal(p.recipient, "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");
  assert.equal(p.resourceUrl, REAL_CHALLENGE.resource.url);
  assert.equal(p.maxTimeoutSeconds, 300);
});

test("decodePaymentRequiredHeader round-trips base64 JSON", () => {
  const header = Buffer.from(JSON.stringify(REAL_CHALLENGE), "utf8").toString("base64");
  const decoded = decodePaymentRequiredHeader(header);
  const p = parseChallenge(decoded);
  assert.equal(p.amount, "50000");
});

test("bindingFromChallenge derives expiry from issuedAt + maxTimeoutSeconds", () => {
  const p = parseChallenge(REAL_CHALLENGE);
  const issuedAtMs = 1_893_456_000_000; // fixed clock
  const b = bindingFromChallenge(p, {
    endpoint: p.resourceUrl,
    method: "POST",
    issuedAtMs,
    deriveExpiryFromTimeout: true,
  });
  assert.equal(b.expiry, String(1_893_456_000 + 300));
  assert.equal(b.method, "POST");
  assert.equal(b.recipient, p.recipient);
  assert.equal(b.endpoint, p.resourceUrl);
});

test("bindingFromChallenge does NOT derive expiry by default (seller bound none ⇒ empty)", () => {
  const p = parseChallenge(REAL_CHALLENGE);
  const b = bindingFromChallenge(p, {
    endpoint: p.resourceUrl,
    method: "POST",
    issuedAtMs: 1_893_456_000_000,
  });
  assert.equal(b.expiry, "");
  assert.equal(b.nonce, "");
});

test("bindingFromChallenge lifts bound fields out of accepts[].extra", () => {
  const withExtra = {
    ...REAL_CHALLENGE,
    accepts: [
      {
        ...REAL_CHALLENGE.accepts[0],
        extra: {
          name: "USD₮0",
          version: "1",
          nonce: "0xfeedface",
          expiry: "1893456300",
          taskHash: "0x" + "a".repeat(64),
          intentHash: "0x" + "b".repeat(64),
          policyId: "42",
          metadataHash: "0x" + "c".repeat(64),
        },
      },
    ],
  };
  const p = parseChallenge(withExtra);
  const b = bindingFromChallenge(p, { endpoint: p.resourceUrl, method: "POST" });
  assert.equal(b.nonce, "0xfeedface");
  assert.equal(b.expiry, "1893456300"); // explicit extra.expiry wins over derived
  assert.equal(b.taskHash, "0x" + "a".repeat(64));
  assert.equal(b.intentHash, "0x" + "b".repeat(64));
  assert.equal(b.policyId, "42");
  assert.equal(b.metadataHash, "0x" + "c".repeat(64));
});

test("preferNetwork picks the matching accepts entry among several", () => {
  const multi = {
    ...REAL_CHALLENGE,
    accepts: [
      { ...REAL_CHALLENGE.accepts[0], network: "eip155:8453", payTo: "0x" + "1".repeat(40) },
      { ...REAL_CHALLENGE.accepts[0], network: "eip155:196", payTo: "0x" + "2".repeat(40) },
    ],
  };
  const p = parseChallenge(multi, { preferNetwork: "eip155:196" });
  assert.equal(p.network, "eip155:196");
  assert.equal(p.recipient, "0x" + "2".repeat(40));
});

test("malformed challenges throw ChallengeParseError", () => {
  assert.throws(() => parseChallenge({ accepts: [] }), ChallengeParseError);
  assert.throws(() => parseChallenge({}), ChallengeParseError);
  assert.throws(() => parseChallenge({ accepts: [{ scheme: "exact" }] }), ChallengeParseError);
});
