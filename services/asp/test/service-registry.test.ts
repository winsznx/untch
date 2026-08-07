import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SERVICES, serviceById } from "../src/registry/services";
import { assertSupported, describeViolations, validate } from "../src/registry/schema";
import { assertNoPrivateReferences, buildListingPayload, listingVerdict, threePartDescription } from "../src/registry/listing";
import { buildOpenApi, buildWellKnownX402 } from "../src/registry/openapi";
import { publicSchemaFor, validateAgainstRegistry } from "../src/registry/routes";
import { buildRegistrationCard } from "../src/erc8004/registration-card";
import { handleCatalog } from "../src/consumer-handlers";

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
   * The defect, stated as a test, on the service that still carries the internal shape.
   *
   * `create_spend_intent` takes the raw sixteen-field object, because hashing one is what it is FOR.
   * Its description therefore has to name all sixteen — a generated description that summarised them
   * as "an intent" would be the rejected listing with a build step in front of it.
   */
  test("a service that really does take the internal struct names all sixteen of its fields", () => {
    const create = serviceById("create_spend_intent");
    assert.ok(create);
    const provide = threePartDescription(create).provide;
    assert.match(provide, /policyId/);
    assert.match(provide, /all 16 of/);
    for (const field of ["owner", "policyHash", "acceptanceHash", "paramsHash", "amount"]) {
      assert.ok(provide.includes(field), `the description does not name ${field}`);
    }
  });

  /**
   * The redesign, stated as a test.
   *
   * Policy preflight used to demand seventeen fields, ten of which were protocol material the caller
   * had no route to obtain. Its published contract now asks for six things a caller knows, and the
   * description says so — briefly, because the request genuinely is brief now.
   */
  test("policy preflight asks for what a caller knows, and nothing it would have to look up", () => {
    const preflight = serviceById("preflight_payment");
    assert.ok(preflight);
    const provide = threePartDescription(preflight).provide;
    for (const field of ["provider", "capability", "task", "maxSpend", "currency", "deadline"]) {
      assert.ok(provide.includes(field), `the description does not name ${field}`);
    }
    assert.match(provide, /either policyId .*, or useDefaultPolicy/);
    for (const derived of ["policyHash", "taskHash", "paramsHash", "nonce"]) {
      assert.ok(!provide.includes(derived), `${derived} is derived server-side and must not be asked for`);
    }
  });

  test("delivery verification asks for the one thing only the caller knows", () => {
    const verify = serviceById("verify_delivery");
    assert.ok(verify);
    const provide = threePartDescription(verify).provide;
    assert.match(provide, /intentId/);
    // The old contract asked the caller to resend acceptance criteria that nothing ever returned.
    assert.ok(!provide.includes("acceptance"), "the caller is being asked for evidence this host holds");
    assert.ok(!provide.includes("policyId"), "the policy is loaded from the intent, not resent");
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
    const create = serviceById("create_spend_intent");
    const intent = create?.input.properties?.intent;
    assert.match(String(intent?.properties?.maxAmount?.description), /DECIMAL STRING/);
    assert.match(String(intent?.properties?.amount?.description), /JSON NUMBER/);
  });
});

describe("what may be listed", () => {
  /**
   * The check that would have stopped the rejected submission, still doing its job.
   *
   * It is asserted against the four services that remain genuinely unreachable — every one of them
   * needs receipt or ledger history this host holds and no public route produces.
   */
  test("a service whose predecessor nobody can obtain is withheld, with the reason recorded", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    const withheldIds = listing.withheld.map((w) => w.toolId);

    for (const stillBlocked of ["score_vendor", "score_buyer", "generate_dispute_packet", "reconcile_agent_spend"]) {
      assert.ok(withheldIds.includes(stillBlocked), `${stillBlocked} must still be withheld`);
    }
    for (const w of listing.withheld) {
      assert.ok(w.blockedBy.length > 0, `${w.toolId} was withheld without a recorded reason`);
    }
    assert.ok(listing.service.length > 0, "withholding must not empty the listing");
    for (const entry of listing.service) {
      assert.equal(listingVerdict(serviceById(entry.toolId)!).listable, true);
    }
  });

  /**
   * The gap the rejected submission was rejected FOR, now closed — asserted so it cannot silently reopen.
   *
   * `preflight_payment` and `verify_delivery` were withheld because both needed a policy id that no
   * public route produced. That is no longer true: `/consumer/policies/draft` and
   * `/consumer/policies/sync` let a stranger register a policy from their own wallet. This test pins
   * the WHOLE chain rather than just the endpoint, because the value of the predecessor graph is that
   * a caller can walk it — and a route named in an `obtainableBy` that does not itself exist as a
   * service would be a chain with a missing link nobody would notice.
   */
  test("the policy chain is walkable end to end, so the two rejected services are reachable", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    const listed = new Set(listing.service.map((s) => s.toolId));

    for (const reachable of ["preflight_payment", "verify_delivery"]) {
      assert.ok(listed.has(reachable), `${reachable} should now be listable`);
    }

    // preflight names a policy…
    const preflight = serviceById("preflight_payment");
    const policyNeed = preflight?.predecessors.find((p) => p.what.includes("registered spend policy"));
    assert.ok(policyNeed?.obtainableBy, "the policy predecessor must name a route");
    assert.match(String(policyNeed?.obtainableBy), /\/consumer\/policies\/draft/);

    // …that route exists as a service of its own…
    const draft = serviceById("policy_draft");
    assert.ok(draft, "the route the policy predecessor names must itself be a registered service");

    // …and it in turn names the account link, which also exists.
    const accountNeed = draft?.predecessors.find((p) => p.what.includes("Untch account"));
    assert.match(String(accountNeed?.obtainableBy), /\/consumer\/account\/link\/start/);
    assert.ok(serviceById("account_link_start"), "the account link must be a registered service");
    assert.ok(serviceById("account_link_complete"));
  });

  test("the registry knows a default policy may stand in for an explicit policyId", () => {
    const setDefault = serviceById("set_default_policy");
    assert.ok(setDefault, "choosing a default must be a described route");
    assert.equal(setDefault?.path, "/consumer/account/default-policy");
    // The refusal a caller hits when they have policies but chose no default, so the listing states
    // that having a policy and having chosen one are separate steps. Renamed from POLICY_NOT_SELECTED
    // when the route learned to resolve a default: one code now covers "you named none and chose none"
    // and "the one you named is not yours", because both mean the same thing to a caller — there is no
    // policy here that may judge this — and both are fixed at the same route.
    assert.ok(
      serviceById("preflight_payment")?.refusals.some((r) => r.code === "POLICY_REQUIRED"),
      "preflight must name the refusal for a request that selected no policy",
    );
  });

  test("the registry knows Telegram and Discord cannot decide before a channel binding exists", () => {
    const decide = serviceById("approval_decide");
    const channel = decide?.predecessors.find((p) => p.what.includes("channel binding"));
    assert.ok(channel, "the approval route must record the channel-binding predecessor");
    assert.match(String(channel?.why), /authorises nothing until that identity has been bound/);
    // Email is named as having NO decision path at all, rather than being left to inference.
    assert.match(String(channel?.why), /Email never gains a decision path/);
  });

  test("an approval decision must name the exact payment, and the schema says so", () => {
    const decide = serviceById("approval_decide");
    const digest = decide?.input.properties?.approvalDigest;
    assert.ok(decide?.input.required?.includes("approvalDigest"), "the digest cannot be optional");
    assert.match(String(digest?.description), /re-quote changes the digest/);
    assert.ok(
      decide?.refusals.some((r) => r.code === "APPROVAL_DIGEST_MISMATCH"),
      "the re-quote refusal must be published, not just implemented",
    );
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

    /**
     * PURCHASABLE, not merely priced.
     *
     * This asserted every paid service appeared, which published ten resources when six could be
     * bought. The other four are the Bureau tools: they carry a price and refuse before any payment
     * challenge, because they answer from receipt history this host holds and a stranger has none.
     * A paying client reads this document FIRST, so listing them there invites payment for a refusal.
     */
    const purchasable = SERVICES.filter(
      (s) => s.pricing.kind === "paid" && s.classification.serviceClass === "MARKETPLACE_LISTABLE",
    );
    assert.equal(doc.resources.length, purchasable.length);

    const advertised = new Set(doc.resources.map((r) => r.toolId));
    for (const s of SERVICES) {
      if (s.pricing.kind !== "paid") continue;
      const listed = s.classification.serviceClass === "MARKETPLACE_LISTABLE";
      assert.equal(
        advertised.has(s.toolId),
        listed,
        listed
          ? `${s.toolId} is sold but absent from x402 discovery`
          : `${s.toolId} refuses before payment and must not be advertised as payable`,
      );
    }

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
    const endpoints = new Set(card.services.map((s) => s.endpoint));

    /**
     * The card advertises what a stranger reading it can CALL.
     *
     * It used to list every registry entry — around twenty-five endpoints, including account-control
     * routes needing an account the reader does not have, Bureau tools that refuse before payment, and
     * the disabled café simulation. After the Cloudflare port most of those answer 503, so a public
     * descriptor pointed largely at dead ends.
     *
     * Asserted in both directions, because "generated, not retyped" is only half the property: the
     * generation must also select the right rows.
     */
    for (const s of SERVICES) {
      const offered =
        s.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
        s.classification.serviceClass === "PUBLIC_SUPPORT";
      assert.equal(
        endpoints.has(`${BASE}${s.path}`),
        offered,
        offered
          ? `${s.toolId} is on offer but missing from the registration card`
          : `${s.toolId} is ${s.classification.serviceClass} and must not be advertised on the card`,
      );
    }
    for (const service of card.services) {
      assert.ok(!/§\s*\d/.test(service.description ?? ""), `${service.endpoint} cites a private section number`);
    }
  });
});

describe("every route is classified, and the class decides the listing", () => {
  /**
   * The listing used to be a predecessor check and nothing else.
   *
   * That check catches routes that are BROKEN for a stranger. It says nothing about routes that work
   * perfectly and are still not products, so twenty-four entries were published including wallet
   * linking, policy drafting, a default-policy setter, an approval-decision route, a health ping and
   * a coffee simulation. Nothing about any of them is broken. The class is what refuses them.
   */
  test("no service is missing a class or a reason", () => {
    for (const s of SERVICES) {
      assert.ok(s.classification, `${s.toolId} has no classification`);
      assert.ok(
        s.classification.reason.trim().length >= 40,
        `${s.toolId} has no real reason recorded for its class`,
      );
    }
  });

  /** A listable service a stranger cannot complete is the exact failure this whole pass exists for. */
  test("everything listed is marketplace-classified and stranger-callable", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    for (const entry of listing.service) {
      const service = serviceById(entry.toolId)!;
      assert.equal(service.classification.serviceClass, "MARKETPLACE_LISTABLE", entry.toolId);
      assert.equal(service.classification.strangerCallable, true, entry.toolId);
    }
  });

  test("nothing outside MARKETPLACE_LISTABLE reaches the listing", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    const listed = new Set(listing.service.map((s) => s.toolId));
    for (const s of SERVICES) {
      if (s.classification.serviceClass === "MARKETPLACE_LISTABLE") continue;
      assert.equal(listed.has(s.toolId), false, `${s.toolId} is ${s.classification.serviceClass} and was listed`);
    }
  });

  /**
   * The specific routes the relisting pass named, pinned by id.
   *
   * A count assertion would pass if one of these were swapped for another; naming them is what makes
   * the test say the thing it means.
   */
  test("the routes that must never be listed are not listed", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    const listed = new Set(listing.service.map((s) => s.toolId));
    const forbidden = [
      "approval_decide",
      "account_link_start",
      "account_link_complete",
      "policy_draft",
      "policy_sync",
      "set_default_policy",
      "catalog",
      "ping_untch",
      "cafe_menu",
      "cafe_order_latte",
      "receipt_status",
      "escalation_status",
      "create_spend_intent",
      "get_ledger",
      "log_receipt",
      "score_vendor",
      "score_buyer",
      "generate_dispute_packet",
      "reconcile_agent_spend",
    ];
    for (const id of forbidden) {
      assert.ok(serviceById(id), `${id} is no longer a service — update this list deliberately`);
      assert.equal(listed.has(id), false, `${id} must not be a marketplace service`);
    }
  });

  /** Charging for a health check or a simulation is what got them declassified. Free is the fix. */
  test("the health check and the cafe simulation are free", () => {
    for (const id of ["ping_untch", "cafe_menu", "cafe_order_latte", "catalog"]) {
      assert.equal(serviceById(id)?.pricing.kind, "free", `${id} must not carry a price`);
    }
  });

  /**
   * The candidate set, exactly.
   *
   * Pinned as a set rather than a count so that adding a service is a deliberate edit to this list
   * with an argument attached, which is the only thing that stops a listing drifting back to
   * twenty-four entries.
   */
  test("the marketplace listing is exactly the nine argued-for services", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    assert.deepEqual(
      listing.service.map((s) => s.toolId).sort(),
      [
        "brand_pack",
        "check_domains",
        "detect_duplicate",
        "preflight_payment",
        "rank_options",
        "redact_payment_metadata",
        "seo_tips",
        "suggest_names",
        "verify_delivery",
      ],
    );
  });

  /** A free entry that 402s, or a paid entry that does not, is a listing that lies about its price. */
  test("every listed price matches the registry, and free means free", () => {
    const listing = buildListingPayload({ baseUrl: BASE, network: "eip155:196", name: "Untch" });
    for (const entry of listing.service) {
      const service = serviceById(entry.toolId)!;
      if (service.pricing.kind === "free") {
        assert.equal(entry.pricing, "free", entry.toolId);
        assert.equal(service.pricing.price, null, entry.toolId);
        assert.equal(service.pricing.amountBaseUnits, null, entry.toolId);
        continue;
      }
      assert.equal(entry.pricing, `${service.pricing.price} per call`, entry.toolId);
      // The display price and the base units are set separately and must describe one amount.
      const dollars = Number(service.pricing.price!.replace("$", ""));
      assert.equal(
        String(Math.round(dollars * 1_000_000)),
        service.pricing.amountBaseUnits,
        `${entry.toolId}: ${service.pricing.price} is not ${service.pricing.amountBaseUnits} base units`,
      );
    }
  });
});

describe("the public catalog is a projection, not a second opinion", () => {
  /**
   * The catalog used to be a hand-written array of `{ path, price, role }` literals beside the
   * registry, and it had already drifted: it advertised `GET /ping_untch` at `0.01` and
   * `POST /cafe/order/latte` at `0.04` after both were made free, and the four Bureau tools at full
   * price after they were gated to refuse before any payment. A caller reading it was told to expect
   * a bill that no longer existed for services that no longer charged.
   */
  test("every catalog entry names a real service at the registry's price", () => {
    const body = handleCatalog().body as {
      surfaces: Record<string, { toolId: string; path: string; price: string }[]>;
    };
    const seen = new Set<string>();
    for (const [surface, entries] of Object.entries(body.surfaces)) {
      for (const entry of entries) {
        const service = serviceById(entry.toolId);
        assert.ok(service, `${surface}: ${entry.toolId} is not a registered service`);
        assert.equal(entry.path, `${service.method} ${service.path}`, entry.toolId);
        if (service.pricing.kind === "free") {
          assert.equal(entry.price, "free", entry.toolId);
        } else {
          // Either the real price, or an explicit statement that it cannot be charged.
          assert.ok(
            entry.price === service.pricing.price || entry.price === "not payable",
            `${entry.toolId}: catalog says ${entry.price}, registry says ${service.pricing.price}`,
          );
        }
        assert.equal(seen.has(entry.toolId), false, `${entry.toolId} appears in two surfaces`);
        seen.add(entry.toolId);
      }
    }
  });

  test("every service marked catalog-visible actually appears, and nothing else does", () => {
    const body = handleCatalog().body as { surfaces: Record<string, { toolId: string }[]> };
    const listed = new Set(Object.values(body.surfaces).flat().map((e) => e.toolId));
    for (const s of SERVICES) {
      assert.equal(
        listed.has(s.toolId),
        s.classification.catalogVisible,
        `${s.toolId}: catalogVisible=${s.classification.catalogVisible} but catalog ${listed.has(s.toolId) ? "shows" : "omits"} it`,
      );
    }
  });

  /** Advertising a price nobody can pay is a subtler version of charging for a simulation. */
  test("a route that refuses before payment does not advertise a price", () => {
    const body = handleCatalog().body as {
      surfaces: Record<string, { toolId: string; price: string; refusesWith?: string }[]>;
    };
    for (const entry of body.surfaces.internalOrWithheld ?? []) {
      assert.equal(entry.price, "not payable", entry.toolId);
      assert.match(entry.refusesWith ?? "", /before any payment challenge/, entry.toolId);
    }
  });
});
