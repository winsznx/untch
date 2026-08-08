import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import {
  deriveNonce,
  mapPreflightRequest,
  missingEvidence,
  parseExpectedResultHash,
  toBaseUnits,
  type MappingContext,
} from "../src/public-dto/mapping";
import type { PublicPreflightRequest } from "../src/public-dto/types";
import { validate, describeViolations } from "../src/registry/schema";
import { serviceById } from "../src/registry/services";
import { SETTLEMENT_TOKEN } from "../src/config";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

const CONTEXT: MappingContext = {
  policy: {
    policyId: "7",
    policyHash: `0x${"44".repeat(32)}`,
    owner: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
  },
  /**
   * The REAL settlement token, imported rather than hardcoded.
   *
   * This mock said `symbol: "USDT0"`, and so did the published example's `currency`. Both were wrong —
   * the token's on-chain symbol is `USD₮`, which is what the live mapping compares against — but they
   * were wrong the SAME way, so the test passed while the example it blessed was refused in production.
   * Importing the symbol makes the mock match reality and makes this drift impossible to reintroduce.
   */
  network: { token: SETTLEMENT_TOKEN.address, symbol: SETTLEMENT_TOKEN.symbol, decimals: SETTLEMENT_TOKEN.decimals },
  provider: {
    providerId: "stabledomains",
    capability: "domains.register",
    endpoint: "https://stabledomains.dev",
    resolvedRecipient: null,
  },
  now: NOW,
};

const REQUEST: PublicPreflightRequest = {
  policyId: "7",
  provider: "stabledomains",
  capability: "domains.register",
  task: "Register kyrve.xyz for one year",
  maxSpend: "20.00",
  currency: SETTLEMENT_TOKEN.symbol,
  deadline: "2030-01-01T00:00:00.000Z",
  recipient: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
  parameters: { domain: "kyrve.xyz", years: 1 },
  buyerAgentId: "6047",
  workerAgentId: "6086",
};

/**
 * The redesign is only worth anything if two properties hold at once: what a caller sends is small
 * and knowable, and nothing missing is quietly filled in. The first is a schema question; the second
 * is what these tests are mostly about, because it is the one that fails silently.
 */
describe("the public request maps onto the protocol object", () => {
  test("six caller fields become a full sixteen-field intent", () => {
    const result = mapPreflightRequest(REQUEST, CONTEXT);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const intent = result.intent;
    assert.equal(intent.owner, CONTEXT.policy.owner, "owner comes from the policy, not the caller");
    assert.equal(intent.policyHash, CONTEXT.policy.policyHash, "the binding is the stored one");
    assert.equal(intent.token, CONTEXT.network.token, "the token is the network's, not the caller's");
    assert.equal(intent.maxAmount, 20_000_000n, "display units became base units");
    assert.equal(intent.endpoint, "https://stabledomains.dev");
    assert.equal(intent.category, "domains.register");
    assert.equal(intent.recipientAddress, REQUEST.recipient?.toLowerCase());
    assert.equal(intent.deadline, BigInt(Math.floor(Date.parse(REQUEST.deadline) / 1000)));
  });

  test("the hashes commit to what the caller actually wrote", () => {
    const result = mapPreflightRequest(REQUEST, CONTEXT);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.intent.taskHash, hashCanonicalJson({ task: REQUEST.task }));
    assert.equal(result.intent.paramsHash, hashCanonicalJson(REQUEST.parameters));
    // No acceptance criteria were sent, so the task text stands in — and the derivation record says so.
    assert.equal(result.intent.acceptanceHash, hashCanonicalJson({ task: REQUEST.task }));
    const note = result.derived.find((d) => d.field === "acceptanceHash");
    assert.match(String(note?.derivedFrom), /because none were given/);
  });

  test("every derived value records what it was derived from", () => {
    const result = mapPreflightRequest(REQUEST, CONTEXT);
    assert.ok(result.ok);
    if (!result.ok) return;
    for (const field of ["owner", "policyHash", "token", "maxAmount", "taskHash", "nonce", "endpoint"]) {
      const record = result.derived.find((d) => d.field === field);
      assert.ok(record, `${field} was derived without recording its source`);
      assert.ok(record.derivedFrom.length > 0);
    }
  });
});

describe("what it refuses to invent", () => {
  /**
   * The whole point. A zero agent id validates, gets judged, gets receipted, and is a decision about
   * an agent that does not exist — and it looks exactly like a correct one.
   */
  test("an unbound wallet is told which authority is missing, not given a zero", () => {
    const { buyerAgentId, workerAgentId, ...unbound } = REQUEST;
    const result = mapPreflightRequest(unbound, CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.equal(result.code, "AUTHORITY_NOT_DERIVABLE");
    const fields = result.missing.map((m) => m.field);
    assert.deepEqual(fields.sort(), ["buyerAgentId", "workerAgentId"]);
    for (const m of result.missing) {
      assert.ok(m.why.length > 0, `${m.field} was refused without a reason`);
      assert.ok(m.resolvedFrom.length > 0, `${m.field} was refused without saying what would supply it`);
    }
  });

  test("an unconstrained recipient with no resolved quote is refused, not filled with this host's own payTo", () => {
    const { recipient, ...noRecipient } = REQUEST;
    const result = mapPreflightRequest(noRecipient, CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    const recipientGap = result.missing.find((m) => m.field === "recipientAddress");
    assert.ok(recipientGap);
    assert.match(recipientGap.why, /not the provider's/);
  });

  test("a resolved quote supplies the recipient without the caller naming one", () => {
    const { recipient, ...noRecipient } = REQUEST;
    const quoted: MappingContext = {
      ...CONTEXT,
      provider: { ...CONTEXT.provider, resolvedRecipient: "0x1111111111111111111111111111111111111111" },
    };
    const result = mapPreflightRequest(noRecipient, quoted);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.intent.recipientAddress, "0x1111111111111111111111111111111111111111");
  });

  test("a currency this network cannot settle is refused rather than mapped to the token it does have", () => {
    const result = mapPreflightRequest({ ...REQUEST, currency: "DAI" }, CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "CURRENCY_NOT_SETTLEABLE");
  });

  test("a deadline that has already passed is refused rather than extended", () => {
    const result = mapPreflightRequest({ ...REQUEST, deadline: "2026-07-01T00:00:00.000Z" }, CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "DEADLINE_IN_THE_PAST");
  });
});

describe("amounts", () => {
  /**
   * `20.10 * 1e6` is 20099999.999999997 in IEEE-754. A ceiling one base unit under what the caller
   * wrote refuses the payment they authorised, intermittently, depending on the amount.
   */
  test("display units become base units by moving the point, not by multiplying a float", () => {
    assert.equal(toBaseUnits("20.10", 6), "20100000");
    assert.equal(toBaseUnits("0.000001", 6), "1");
    assert.equal(toBaseUnits("1", 6), "1000000");
    assert.equal(toBaseUnits("0", 6), "0");
    assert.equal(toBaseUnits("1234567.891234", 6), "1234567891234");
  });

  test("more precision than the token has is a caller error, not a rounding decision", () => {
    assert.equal(toBaseUnits("0.0000001", 6), null);
    assert.equal(toBaseUnits("twenty", 6), null);
    assert.equal(toBaseUnits("-1", 6), null);
  });
});

describe("idempotency", () => {
  test("the same key produces the same nonce, so a retry resolves to the same intent", () => {
    const withKey: PublicPreflightRequest = { ...REQUEST, idempotencyKey: "order-1" };
    assert.equal(deriveNonce(withKey, NOW), deriveNonce(withKey, NOW + 60_000));
  });

  test("a different key produces a different nonce", () => {
    assert.notEqual(
      deriveNonce({ ...REQUEST, idempotencyKey: "order-1" }, NOW),
      deriveNonce({ ...REQUEST, idempotencyKey: "order-2" }, NOW),
    );
  });

  test("without a key, two separate purchases of the same thing do not collide", () => {
    assert.notEqual(deriveNonce(REQUEST, NOW), deriveNonce(REQUEST, NOW + 1));
  });
});

describe("verification asks for one thing and loads the rest", () => {
  test("the published contract requires only an intent id", () => {
    const verify = serviceById("verify_delivery");
    assert.deepEqual(verify?.input.required, ["intentId"]);
    assert.deepEqual(Object.keys(verify?.input.properties ?? {}).sort(), ["expectedResultHash", "intentId"]);
  });

  test("an incomplete record is named, not judged around", () => {
    const gaps = missingEvidence({
      intentId: `0x${"11".repeat(32)}`,
      policyFound: true,
      intentFound: true,
      quoteFound: false,
      executionFound: true,
      settlementFound: false,
      resultFound: true,
      receiptFound: true,
    });
    assert.equal(gaps.length, 2);
    assert.ok(gaps.some((g) => /quote/.test(g)));
    assert.ok(gaps.some((g) => /settlement/.test(g)));
  });

  test("a caller-asserted result hash is shape-checked before it is compared to anything", () => {
    assert.equal(parseExpectedResultHash(undefined), null);
    assert.equal(parseExpectedResultHash("0xdead"), null);
    assert.equal(parseExpectedResultHash(`0x${"AB".repeat(32)}`), `0x${"ab".repeat(32)}`);
  });
});

describe("the published contract and the mapping agree", () => {
  test("the example the schema publishes as valid is one the mapping accepts", () => {
    const preflight = serviceById("preflight_payment");
    assert.ok(preflight);
    const example = preflight.validExample.request as PublicPreflightRequest;

    assert.equal(describeViolations(validate(preflight.input, example)), null, "the example fails its own schema");
    const mapped = mapPreflightRequest(example, {
      ...CONTEXT,
      now: Date.parse("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(mapped.ok, true, "the example passes the schema but the mapping refuses it");
  });

  test("nothing the mapping derives appears in the published request shape", () => {
    const preflight = serviceById("preflight_payment");
    const published = Object.keys(preflight?.input.properties ?? {});
    for (const derivedField of [
      "policyHash",
      "owner",
      "token",
      "taskHash",
      "acceptanceHash",
      "schemaHash",
      "paramsHash",
      "nonce",
      "endpoint",
      "maxAmount",
    ]) {
      assert.ok(
        !published.includes(derivedField),
        `${derivedField} is derived server-side and must not be askable — a binding the caller can choose is not a binding`,
      );
    }
  });
});
