import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleCafeMenu,
  handleCafeOrderLatte,
  handleCatalog,
  handleCheckDomains,
  handleRankOptions,
  handleSeoTips,
  handleSuggestNames,
} from "../src/consumer-handlers";

test("catalog lists control + lifestyle + builder surfaces", () => {
  const r = handleCatalog();
  assert.equal(r.status, 200);
  const body = r.body as {
    type: string;
    baseUrl: string;
    surfaces: { control: unknown[]; lifestyle: unknown[]; builder: unknown[] };
  };
  assert.equal(body.type, "A2MCP");
  assert.equal(body.baseUrl, "https://asp.untch.xyz");
  assert.ok(body.surfaces.control.length >= 6);
  assert.ok(body.surfaces.lifestyle.length >= 2);
  assert.ok(body.surfaces.builder.length >= 4);
});

test("cafe menu is free and machine-readable", () => {
  const r = handleCafeMenu();
  assert.equal(r.status, 200);
  const body = r.body as { items: { sku: string }[]; currency: string };
  assert.equal(body.currency, "USDT0");
  assert.ok(body.items.some((i) => i.sku === "latte"));
});

test("cafe latte order returns pickup voucher", () => {
  const r = handleCafeOrderLatte({ buyerRef: "agent-demo" });
  assert.equal(r.status, 200);
  const body = r.body as {
    orderId: string;
    pickupCode: string;
    amountPaid: string;
    status: string;
    buyerRef: string;
  };
  assert.equal(body.amountPaid, "4.00");
  assert.equal(body.status, "PAID_READY_FOR_PICKUP");
  assert.equal(body.buyerRef, "agent-demo");
  assert.match(body.pickupCode, /^UNTCH-/);
  assert.ok(body.orderId.startsWith("cafe_"));
});

test("suggest_names requires idea and is deterministic", () => {
  const bad = handleSuggestNames({});
  assert.equal(bad.status, 400);

  const a = handleSuggestNames({ idea: "agent spend control" });
  const b = handleSuggestNames({ idea: "agent spend control" });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  const body = a.body as { suggestions: { name: string; score: number }[] };
  assert.ok(body.suggestions.length >= 4);
  assert.ok(body.suggestions.every((s) => s.name.length > 0 && s.score > 0));
});

test("check_domains expands TLDs deterministically", () => {
  const r = handleCheckDomains({ names: ["untchdemo"] });
  assert.equal(r.status, 200);
  const body = r.body as { results: { domain: string; status: string }[] };
  assert.equal(body.results.length, 4); // .xyz .com .ai .dev
  assert.ok(body.results.every((x) => x.domain.startsWith("untchdemo.")));
});

test("rank_options sorts higher scores first", () => {
  const r = handleRankOptions({ names: ["ab", "BrightKit", "x-y-z-long-name-here"] });
  assert.equal(r.status, 200);
  const body = r.body as { ranked: { name: string; score: number }[]; top: string };
  assert.equal(body.ranked[0]?.name, body.top);
  for (let i = 1; i < body.ranked.length; i++) {
    assert.ok(body.ranked[i - 1]!.score >= body.ranked[i]!.score);
  }
});

test("seo_tips requires name", () => {
  assert.equal(handleSeoTips({}).status, 400);
  const r = handleSeoTips({ name: "Untch" });
  assert.equal(r.status, 200);
  const body = r.body as { tips: string[] };
  assert.ok(body.tips.length >= 4);
});
