import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SERVICES, serviceById } from "../src/registry/services";
import { assertSupported, describeViolations, validate } from "../src/registry/schema";
import { assertNoPrivateReferences, buildListingPayload, listingVerdict, threePartDescription } from "../src/registry/listing";
import { buildOpenApi, buildWellKnownX402 } from "../src/registry/openapi";
import { publicSchemaFor, validateAgainstRegistry } from "../src/registry/routes";
import { buildRegistrationCard } from "../src/erc8004/registration-card";

const BASE = "https://asp.untch.xyz";

/**
 * What is worth testing about a registry is not that it has entries — it is the three claims the
 * audit found were false, restated as properties that now hold for every entry and cannot be true of
 * only the ones someone remembered:
 *
 *   1. the published contract and the enforced one are the same document;
 *   2. a description says what the validator actually demands, in full;
 *   3. a service nobody can complete is not offered as though they could.
 */
describe("the registry describes what is actually enforced", () => {
  test("every schema uses only constructs the validator implements", () => {
    // The failure mode of a partial validator is silence, not noise: a rule it does not understand is
    // published and never checked. This is what makes that impossible.
    for (const s of SERVICES) {
      assertSupported(s.input, `${s.toolId}.input`);
      assertSupported(s.output, `${s.toolId}.output`);
    }
  });

  test("every valid example passes its own contract", () => {
    for (const s of SERVICES) {
      if (s.validExample.request === null) continue; // A GET with no body has nothing to check.
      const violations = validate(s.input, s.validExample.request);
      assert.equal(
        describeViolations(violations),
        null,
        `${s.toolId}: the example published as valid does not satisfy the published schema`,
      );
    }
  });

  test("every invalid example is actually refused, and names the code it is refused with", () => {
    for (const s of SERVICES) {
      assert.ok(s.invalidExample.refusalCode, `${s.toolId}: an invalid example must name its refusal code`);
      const declared = s.refusals.map((r) => r.code);
      assert.ok(
        declared.includes(s.invalidExample.refusalCode as string),
        `${s.toolId}: the example is refused with ${s.invalidExample.refusalCode}, which is not in its declared refusals`,
      );
    }
  });

  test("the schema-level refusals a caller can hit are reachable through the shared validator", () => {
    // Not every refusal is a schema violation — some need stored state. The ones that ARE must fire.
    const violation = validateAgainstRegistry("preflight_payment", {});
    assert.ok(violation, "an empty body must not satisfy policy preflight");
    assert.equal(violation.code, "REQUEST_SCHEMA_VIOLATION");
    assert.match(violation.message, /policyId/);
    assert.match(violation.message, /\/schema\/preflight_payment/);
  });

  test("tool ids are unique and stable-looking", () => {
    const ids = SERVICES.map((s) => s.toolId);
    assert.equal(new Set(ids).size, ids.length, "two services share a tool id");
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} is not a stable machine id`);
  });

  test("every service is reachable by id", () => {
    for (const s of SERVICES) assert.equal(serviceById(s.toolId)?.toolId, s.toolId);
    assert.equal(serviceById("no_such_tool"), undefined);
  });
});

describe("the generated listing description", () => {
  test("has all three parts OKX requires, for every service", () => {
    for (const s of SERVICES) {
      const d = threePartDescription(s);
      assert.ok(d.what.length > 0, `${s.toolId}: part one is empty`);
      assert.match(d.provide, /^You provide: /, `${s.toolId}: part two is missing`);
      assert.match(d.receive, /^You receive: /, `${s.toolId}: part three is missing`);
      // The rejected listings shipped two parts. Part three was absent entirely.
      assert.equal(d.text.split("\n\n").length, 3, `${s.toolId}: the joined description is not three parts`);
    }
  });

  /**
   * The defect, stated as a test.
   *
   * The registered description said policy preflight needed two things. The validator demanded
   * seventeen. A generated description that reproduced that number would be the same failure with a
   * build step in front of it.
   */
  test("names every field the validator demands, including the sixteen inside the intent", () => {
    const preflight = serviceById("preflight_payment");
    assert.ok(preflight);
    const provide = threePartDescription(preflight).provide;
    assert.match(provide, /policyId/);
    assert.match(provide, /all 16 of/);
    for (const field of ["owner", "policyHash", "acceptanceHash", "paramsHash", "amount"]) {
      assert.ok(provide.includes(field), `the description does not name ${field}`);
    }
    assert.match(provide, /either .*intent.*, or intentHash/s);
  });

  test("verify_delivery names BOTH of its independent choices", () => {
    const verify = serviceById("verify_delivery");
    assert.ok(verify);
    const provide = threePartDescription(verify).provide;
    assert.match(provide, /intentHash/);
    assert.match(provide, /payloadHash/);
  });

  test("no description cites a private section number", () => {
    for (const s of SERVICES) {
      // Would throw. Asserted explicitly so a failure names the rule rather than only the service.
      threePartDescription(s);
    }
    assert.throws(
      () => assertNoPrivateReferences("deterministic §7.1 policy preflight", "a test"),
      /points into a document/,
      "the check must catch the exact form the rejected listing used",
    );
    assert.throws(() => assertNoPrivateReferences("see PRD for detail", "a test"), /points into a document/);
  });

  test("the number-inversion trap is stated where a caller will read it", () => {
    const preflight = serviceById("preflight_payment");
    const intent = preflight?.input.properties?.intent;
    assert.match(String(intent?.properties?.maxAmount?.description), /DECIMAL STRING/);
    assert.match(String(intent?.properties?.amount?.description), /JSON NUMBER/);
  });
});

describe("what may be listed", () => {
  /**
   * The check that would have stopped the rejected submission.
   *
   * Both services were listed, and both required a policy id that no public route produces. A caller
   * could follow the listing exactly, pay, and be refused.
   */
  test("a service whose predecessor nobody can obtain is withheld, with the reason recorded", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    const withheldIds = listing.withheld.map((w) => w.toolId);

    assert.ok(withheldIds.includes("preflight_payment"));
    assert.ok(withheldIds.includes("verify_delivery"));
    for (const w of listing.withheld) {
      assert.ok(w.blockedBy.length > 0, `${w.toolId} was withheld without a recorded reason`);
    }
    assert.ok(listing.service.length > 0, "withholding must not empty the listing");
    for (const entry of listing.service) {
      assert.equal(listingVerdict(serviceById(entry.toolId)!).listable, true);
    }
  });

  test("every listed entry carries a free schema URL and a schema version", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    for (const entry of listing.service) {
      assert.equal(entry.schemaUrl, `${BASE}/schema/${entry.toolId}`);
      assert.match(entry.schemaVersion, /^\d+\.\d+\.\d+$/);
    }
  });
});

describe("the generated machine-readable surfaces", () => {
  test("OpenAPI carries every service, with its reachability and its cost", () => {
    const doc = buildOpenApi({ baseUrl: BASE, network: "eip155:196" }) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    for (const s of SERVICES) {
      const op = doc.paths[s.path]?.[s.method.toLowerCase()];
      assert.ok(op, `${s.toolId} is missing from the OpenAPI document`);
      assert.equal(op["x-untch-idempotency"], s.idempotency);
      assert.equal(op["x-untch-maturity"], s.maturity);
      assert.deepEqual(op["x-untch-pricing"], s.pricing);
      // A spec that omits reachability describes a door without mentioning it is locked.
      assert.deepEqual(op["x-untch-predecessors"], s.predecessors);
    }
  });

  test("every paid route appears in the x402 document with a schema link", () => {
    const doc = buildWellKnownX402({
      baseUrl: BASE,
      network: "eip155:196",
      payTo: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba",
      asset: { symbol: "USD₮", address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", decimals: 6 },
    }) as { x402Version: number; resources: Array<Record<string, unknown>> };

    assert.equal(doc.x402Version, 2);
    const paid = SERVICES.filter((s) => s.pricing.kind === "paid");
    assert.equal(doc.resources.length, paid.length);
    for (const r of doc.resources) {
      assert.equal(r.schema, `${BASE}/schema/${r.toolId}`);
      assert.ok(r.amountBaseUnits, `${r.toolId} publishes no base-unit amount`);
    }
  });

  test("the served schema carries the things a schema alone cannot say", () => {
    const served = publicSchemaFor(serviceById("verify_delivery")!, BASE);
    assert.ok(Array.isArray(served.predecessors));
    assert.ok(Array.isArray(served.sideEffects));
    assert.equal(served.idempotency, "not-idempotent");
    // A retried paid verify writes a second receipt and charges again. The listing never said so.
    const effects = served.sideEffects as Array<{ what: string }>;
    assert.ok(effects.some((e) => /twice/.test(e.what)));
  });

  test("the ERC-8004 card's service list is generated, not retyped", () => {
    const card = buildRegistrationCard({ payTo: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba", baseUrl: BASE });
    const endpoints = card.services.map((s) => s.endpoint);
    for (const s of SERVICES) {
      assert.ok(endpoints.includes(`${BASE}${s.path}`), `${s.toolId} is missing from the registration card`);
    }
    for (const service of card.services) {
      assert.ok(!/§\s*\d/.test(service.description ?? ""), `${service.endpoint} cites a private section number`);
    }
  });
});
