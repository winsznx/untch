import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleBrandPack,
  handleCafeMenu,
  handleCafeOrderLatte,
  handleCatalog,
  handleCheckDomains,
  handleRankOptions,
  handleSeoTips,
  handleSuggestNames,
} from "../src/consumer-handlers";
import { fallbackSuggestNames } from "../src/launch-pack/names";
import { rankBrandNames } from "../src/launch-pack/rank";
import { loadLlmConfig } from "../src/launch-pack/llm";
import { isBannedBrand } from "../src/launch-pack/anti-slop";

/**
 * The catalog groups by CLASS now, not by topic.
 *
 * It used to group by control / lifestyle / builder, which describes what a service is about. A
 * caller deciding whether to spend needs to know what it IS: something they can buy, something only
 * useful once they have an account here, or something this host will refuse them.
 */
test("catalog groups services by class and reaches every surface from the registry", () => {
  const r = handleCatalog();
  assert.equal(r.status, 200);
  const body = r.body as {
    type: string;
    baseUrl: string;
    surfaces: Record<string, { toolId: string; path: string; price: string }[]>;
    launchPack: { hireFlow: string[] };
  };
  assert.equal(body.type, "A2MCP");
  assert.equal(body.baseUrl, "https://asp.untch.xyz");

  assert.deepEqual(Object.keys(body.surfaces).sort(), [
    "accountControl",
    "internalOrWithheld",
    "marketplace",
    "productionDisabled",
    "publicSupport",
  ]);

  // The nine argued-for marketplace services, brand_pack among them.
  assert.equal(body.surfaces.marketplace?.length, 9);
  assert.ok(body.surfaces.marketplace?.some((b) => b.path.includes("brand_pack")));
  assert.ok(body.launchPack.hireFlow.length >= 1);
});

/** Both used to carry a price here after they had been made free. */
test("catalog reports the health check and the cafe simulation as free", () => {
  const body = handleCatalog().body as { surfaces: Record<string, { toolId: string; price: string }[]> };
  const all = Object.values(body.surfaces).flat();
  for (const toolId of ["ping_untch", "cafe_menu", "cafe_order_latte", "catalog"]) {
    assert.equal(all.find((e) => e.toolId === toolId)?.price, "free", toolId);
  }
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

test("suggest_names requires idea and is deterministic without LLM", async () => {
  const bad = await handleSuggestNames({});
  assert.equal(bad.status, 400);

  const prevXai = process.env.XAI_API_KEY;
  const prevOpen = process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const a = await handleSuggestNames({ idea: "agent spend control" });
    const b = await handleSuggestNames({ idea: "agent spend control" });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
    const body = a.body as {
      suggestions: { name: string; score: number }[];
      engine: string;
    };
    assert.equal(body.engine, "fallback");
    assert.ok(body.suggestions.length >= 4);
    assert.ok(body.suggestions.every((s) => s.name.length > 0 && s.score > 0));
  } finally {
    if (prevXai !== undefined) process.env.XAI_API_KEY = prevXai;
    else delete process.env.XAI_API_KEY;
    if (prevOpen !== undefined) process.env.OPENAI_API_KEY = prevOpen;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("fallback name generator is deterministic and brandable", () => {
  const a = fallbackSuggestNames("agent spend control", 6);
  const b = fallbackSuggestNames("agent spend control", 6);
  assert.deepEqual(a, b);
  assert.equal(a.length, 6);
  for (const s of a) {
    assert.match(s.name, /^[A-Za-z][A-Za-z0-9]*$/);
    assert.ok(s.name.length >= 3 && s.name.length <= 18);
  }
});

test("check_domains expands TLDs and returns RDAP-shaped results", async () => {
  const r = await handleCheckDomains({ names: ["untchdemo"] });
  assert.equal(r.status, 200);
  const body = r.body as {
    results: { domain: string; status: string; source: string }[];
    source: string;
  };
  assert.equal(body.source, "rdap");
  assert.equal(body.results.length, 5); // .com .xyz .ai .dev .io
  assert.ok(body.results.every((x) => x.domain.startsWith("untchdemo.")));
  assert.ok(body.results.every((x) => x.source === "rdap"));
  assert.ok(body.results.every((x) => ["AVAILABLE", "TAKEN", "UNKNOWN"].includes(x.status)));
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

test("rankBrandNames prefers ideal length and alpha-only", () => {
  const { ranked, top } = rankBrandNames(["ab", "BrightKit", "x-y-z-long-name-here"]);
  assert.equal(top, "BrightKit");
  assert.ok(ranked[0]!.score > ranked[ranked.length - 1]!.score);
});

test("seo_tips requires name", () => {
  assert.equal(handleSeoTips({}).status, 400);
  const r = handleSeoTips({ name: "Untch" });
  assert.equal(r.status, 200);
  const body = r.body as { tips: string[]; handles: { domains: string[] } };
  assert.ok(body.tips.length >= 4);
  assert.ok(body.handles.domains.some((d) => d.includes("untch")));
});

test("brand_pack returns names + domains + rank + seo without LLM", async () => {
  const bad = await handleBrandPack({});
  assert.equal(bad.status, 400);

  const prevXai = process.env.XAI_API_KEY;
  const prevOpen = process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await handleBrandPack({ idea: "agent spend control for crypto wallets" });
    assert.equal(r.status, 200);
    const body = r.body as {
      engine: string;
      suggestions: unknown[];
      ranked: { name: string; availableDomains: string[] }[];
      top: string;
      domains: { domain: string; status: string }[];
      seo: { tips: string[] } | null;
      paidTool: string;
    };
    assert.equal(body.engine, "fallback");
    assert.equal(body.paidTool, "brand_pack");
    assert.ok(body.suggestions.length >= 3);
    assert.ok(body.ranked.length >= 1);
    assert.ok(body.top.length > 0);
    assert.ok(body.domains.length >= 3);
    assert.ok(body.seo && body.seo.tips.length >= 4);
  } finally {
    if (prevXai !== undefined) process.env.XAI_API_KEY = prevXai;
    else delete process.env.XAI_API_KEY;
    if (prevOpen !== undefined) process.env.OPENAI_API_KEY = prevOpen;
    else delete process.env.OPENAI_API_KEY;
  }
});

test("loadLlmConfig prefers XAI when set; Groq second", () => {
  assert.equal(loadLlmConfig({}), null);
  const xai = loadLlmConfig({ XAI_API_KEY: "xai-test", XAI_MODEL: "grok-3-mini" });
  assert.ok(xai);
  assert.equal(xai!.provider, "xai");
  assert.equal(xai!.baseUrl, "https://api.x.ai/v1");
  assert.equal(xai!.model, "grok-3-mini");

  const groq = loadLlmConfig({ GROQ_API_KEY: "gsk-test" });
  assert.ok(groq);
  assert.equal(groq!.provider, "groq");
  assert.equal(groq!.baseUrl, "https://api.groq.com/openai/v1");
  assert.match(groq!.model, /llama/);
});

test("fallback names reject AI-slop stems", () => {
  assert.equal(isBannedBrand("AegisSentinel"), true);
  assert.equal(isBannedBrand("NexusPrime"), true);
  assert.equal(isBannedBrand("FieldKit"), false);
  assert.equal(isBannedBrand("Untch"), true);

  const names = fallbackSuggestNames("agent spend control wallet", 6);
  for (const s of names) {
    assert.equal(isBannedBrand(s.name), false, s.name);
  }
});
