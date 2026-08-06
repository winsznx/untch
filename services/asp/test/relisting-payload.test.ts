import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ERC8004_AGENT_ID,
  OKX_ASP_ID,
  assertMarketplaceIdentity,
  marketplaceIdentityViolations,
} from "../src/registry/marketplace-identity";
import {
  CAPABILITIES,
  COMPLETE_DESCRIPTION,
  CONCISE_DESCRIPTION,
  RELISTING_INSTRUCTION,
  buildRelistingPayload,
  diffAgainstStoredListing,
  reviewerInstructions,
  withheldSummary,
} from "../src/registry/relisting-payload";
import { serviceById } from "../src/registry/services";

/**
 * Two numbers four digits apart, and only one of them may appear as an ASP id.
 *
 * ASP #6086 carries the sales count and the review state. Agent #6047 is the ERC-8004 on-chain
 * identity. Relisting under 6047 would create a second, unrelated marketplace presence and orphan
 * the real one — and nothing structural stops that, because both are plain integers sitting in
 * adjacent documents. These tests are the structure.
 */

const PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";
const PFP =
  "https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/c00d3425-c37e-4343-8a6a-5d25ca831278.png";

const CHANNELS = [
  { channel: "discord", status: "live" },
  { channel: "telegram", status: "disabled — the stored bot credential is not authorised" },
];

function payload() {
  return buildRelistingPayload({
    payTo: PAY_TO,
    profilePictureUrl: PFP,
    sdkVersion: "0.1.1",
    approvalChannels: CHANNELS,
  });
}

describe("marketplace identity", () => {
  test("the payload targets the existing ASP", () => {
    assert.equal(payload().aspId, 6086);
    assert.equal(OKX_ASP_ID, 6086);
  });

  test("the ERC-8004 agent id is present, labelled, and never the ASP id", () => {
    const p = payload();
    assert.equal(p.erc8004.agentId, 6047);
    assert.notEqual(p.aspId, ERC8004_AGENT_ID);
    assert.match(p.erc8004.role, /never the ASP id/i);
  });

  /** The exact mistake this module exists to stop, with the reason it is dangerous in the message. */
  test("the agent id in the ASP position is refused, and the refusal explains why", () => {
    const violations = marketplaceIdentityViolations({ aspId: ERC8004_AGENT_ID, urls: [] });
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.detail, /ERC-8004 agent id/);
    assert.match(violations[0]!.detail, /second marketplace presence/);
  });

  test("any other ASP id is refused too", () => {
    assert.throws(() => assertMarketplaceIdentity({ aspId: 1234, urls: [] }));
    assert.throws(() => assertMarketplaceIdentity({ aspId: "6086", urls: [] }));
    assert.throws(() => assertMarketplaceIdentity({ aspId: null, urls: [] }));
  });

  /** A URL that outlives neither a branch nor a laptop cannot be in a listing a reviewer will open. */
  test("a temporary endpoint is refused and named", () => {
    for (const url of [
      "https://untch-asp-production.up.railway.app/preflight_payment",
      "https://untch.vercel.app/catalog",
      "https://abc123.ngrok-free.app/preflight_payment",
      "http://localhost:4021/preflight_payment",
      "https://something.trycloudflare.com/x",
    ]) {
      const violations = marketplaceIdentityViolations({ aspId: OKX_ASP_ID, urls: [url] });
      assert.equal(violations.length, 1, url);
      assert.equal(violations[0]!.what, url);
    }
  });

  test("http is refused even on a production host", () => {
    const violations = marketplaceIdentityViolations({
      aspId: OKX_ASP_ID,
      urls: ["http://asp.untch.xyz/preflight_payment"],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.detail, /https/);
  });

  test("every URL in the generated payload is a stable production endpoint", () => {
    const p = payload();
    const urls = [
      p.productionUrl,
      p.docsUrl,
      p.siteUrl,
      ...p.services.map((s) => s.endpoint),
      ...p.services.map((s) => s.inputSchemaUrl),
    ];
    assert.deepEqual(marketplaceIdentityViolations({ aspId: p.aspId, urls }), []);
    for (const url of urls) assert.match(url, /^https:\/\/(asp\.|docs\.)?untch\.xyz/);
  });

  test("the relisting instruction updates rather than registers, and rules out the agent id", () => {
    assert.match(RELISTING_INSTRUCTION, /update and relist the existing A2MCP ASP\s+#6086/);
    assert.match(RELISTING_INSTRUCTION, /Do not register a new ASP/);
    assert.match(RELISTING_INSTRUCTION, /Do not use 6047/);
  });
});

describe("the relisting payload", () => {
  test("it carries exactly the nine listed services, with prices matching the registry", () => {
    const p = payload();
    assert.equal(p.services.length, 9);
    assert.equal(p.services.filter((s) => s.paid).length, 6);
    assert.equal(p.services.filter((s) => !s.paid).length, 3);
    for (const s of p.services) {
      const service = serviceById(s.toolId)!;
      assert.equal(s.price, service.pricing.price, s.toolId);
      assert.equal(s.amountBaseUnits, service.pricing.amountBaseUnits, s.toolId);
      assert.equal(s.paid, service.pricing.kind === "paid", s.toolId);
      assert.equal(s.endpoint, `https://asp.untch.xyz${service.path}`, s.toolId);
      assert.equal(s.method, service.method, s.toolId);
    }
  });

  test("the settlement facts are the ones the running service actually uses", () => {
    const p = payload();
    assert.equal(p.network, "eip155:196");
    assert.equal(p.settlementToken.address, "0x779ded0c9e1022225f8e0630b35a9b54be713736");
    assert.equal(p.settlementToken.decimals, 6);
    assert.equal(p.payTo, PAY_TO);
    assert.equal(p.paymentSdk.middleware, "@okxweb3/x402-express");
  });

  test("the profile picture is declared square", () => {
    const p = payload();
    assert.equal(p.profilePicture.width, p.profilePicture.height);
    assert.equal(p.profilePicture.mimeType, "image/png");
  });

  /**
   * Copy is checked for its load-bearing claims, not its wording.
   *
   * A test that pinned the exact sentence would fail on an ordinary edit and teach everyone to
   * delete it. What must not silently disappear is the product's own line and its core rule.
   */
  test("the description states what Untch is without underselling it", () => {
    assert.match(CONCISE_DESCRIPTION, /The model never touches the money/);
    assert.match(COMPLETE_DESCRIPTION, /control plane for agent money/i);
    assert.match(COMPLETE_DESCRIPTION, /exact commercial intents/i);
    assert.match(COMPLETE_DESCRIPTION, /approves, blocks or escalates/i);
    assert.match(COMPLETE_DESCRIPTION, /bounded reserved authority/i);
    assert.ok(CAPABILITIES.length >= 10);
  });

  /**
   * The listing must not lead with what Untch cannot do.
   *
   * A "what we do not claim" section belongs in engineering notes and not in marketplace copy, where
   * it reads as a warning about the product rather than as precision about a service.
   */
  test("the description does not lead with limitations", () => {
    const copy = `${CONCISE_DESCRIPTION} ${COMPLETE_DESCRIPTION}`.toLowerCase();
    for (const phrase of ["does not claim", "cannot", "limitation", "not yet", "unavailable"]) {
      assert.equal(copy.includes(phrase), false, `the listing copy leads with "${phrase}"`);
    }
  });

  /**
   * verify_delivery must never read as Untch having done the work.
   *
   * It evaluates submitted evidence. A buyer who read it as proof that a provider was paid and a
   * thing was delivered would be buying a different product than the one that runs.
   */
  test("verify_delivery states that it evaluates evidence, not that Untch delivered", () => {
    const entry = payload().services.find((s) => s.toolId === "verify_delivery")!;
    const text = `${entry.description} ${entry.outputSummary}`.toLowerCase();
    assert.match(text, /evidence|criteria|verif/);
    for (const overclaim of ["untch delivered", "we delivered", "settled the provider", "paid the provider"]) {
      assert.equal(text.includes(overclaim), false, `verify_delivery claims "${overclaim}"`);
    }
  });

  test("a channel the listing cannot reach is declared disabled rather than claimed", () => {
    const telegram = payload().approvalChannels.find((c) => c.channel === "telegram")!;
    assert.match(telegram.status, /disabled/);
  });
});

describe("the diff against the stored listing", () => {
  /** The 24 entries ASP #6086 was carrying before this pass, with the two that changed price. */
  const STORED = [
    { toolId: "preflight_payment", price: "$0.05" },
    { toolId: "verify_delivery", price: "$0.10" },
    { toolId: "cafe_order_latte", price: "$0.04" },
    { toolId: "brand_pack", price: "$0.05" },
    { toolId: "ping_untch", price: "$0.01" },
    { toolId: "catalog", price: null },
    { toolId: "account_link_start", price: null },
    { toolId: "approval_decide", price: null },
  ];

  test("every removal carries the reason it was removed", () => {
    const diff = diffAgainstStoredListing(payload(), STORED);
    const removed = diff.removed.map((r) => r.toolId).sort();
    assert.deepEqual(removed, [
      "account_link_start",
      "approval_decide",
      "cafe_order_latte",
      "catalog",
      "ping_untch",
    ]);
    for (const r of diff.removed) {
      assert.match(r.reason, /classified (PUBLIC_SUPPORT|ACCOUNT_CONTROL|INTERNAL_OR_WITHHELD|PRODUCTION_DISABLED)/);
    }
  });

  test("nothing that stays changed price", () => {
    const diff = diffAgainstStoredListing(payload(), STORED);
    assert.deepEqual(diff.priceChanges, []);
    assert.deepEqual(diff.kept.sort(), ["brand_pack", "preflight_payment", "verify_delivery"]);
  });

  test("the newly listed services are the ones this pass validated", () => {
    const diff = diffAgainstStoredListing(payload(), STORED);
    assert.deepEqual(diff.added.sort(), [
      "check_domains",
      "detect_duplicate",
      "rank_options",
      "redact_payment_metadata",
      "seo_tips",
      "suggest_names",
    ]);
  });
});

describe("what a reviewer is told", () => {
  test("the instructions cover every listed service and need no Untch account", () => {
    const p = payload();
    const text = reviewerInstructions(p);
    for (const s of p.services) assert.ok(text.includes(s.endpoint), `${s.toolId} is not in the instructions`);
    assert.match(text, /No Untch account is needed/i);
    assert.match(text, /payment-sdk-health/);
  });

  /** The two services with a prerequisite must say so where a reviewer will read it. */
  test("the prerequisites are disclosed, not discovered after paying", () => {
    const text = reviewerInstructions(payload());
    assert.match(text, /preflight_payment needs a registered spend policy/);
    assert.match(text, /policies\/draft/);
    assert.match(text, /policies\/sync/);
    assert.match(text, /verify_delivery needs an intent created on this host/);
  });

  test("every withheld service explains itself", () => {
    const withheld = withheldSummary();
    assert.equal(withheld.length, 19);
    for (const w of withheld) {
      assert.notEqual(w.serviceClass, "MARKETPLACE_LISTABLE", w.toolId);
      assert.ok(w.reason.length >= 40, `${w.toolId} has no real reason`);
    }
  });
});
