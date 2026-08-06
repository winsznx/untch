/**
 * Consumer / lifestyle / builder ASP tools.
 * Control-plane money decisions stay LLM-free (I1). Launch Pack may use an LLM for naming only.
 */

import { SERVICES } from "./registry/services";
import type { HandlerResult } from "./handlers";
import { loadLlmConfig } from "./launch-pack/llm";
import { suggestProductNames } from "./launch-pack/names";
import { checkDomainsLive, DEFAULT_TLDS } from "./launch-pack/rdap";
import { rankBrandNames } from "./launch-pack/rank";

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

function asString(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function parseNameList(raw: unknown, max = 12): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, max);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

// ── Café (lifestyle demo) ────────────────────────────────────────────────────

const CAFE_MENU = [
  { sku: "drip", name: "House drip", price: "2.80", available: true },
  { sku: "latte", name: "Oat latte", price: "4.00", available: true, note: "substitution when drip sold out" },
  { sku: "flight", name: "Tasting flight", price: "12.00", available: true },
] as const;

/** Free — machine-readable café catalog for agents. */
export function handleCafeMenu(): HandlerResult {
  return {
    status: 200,
    body: {
      vendorId: "untch-demo-cafe",
      currency: "USDT0",
      network: "eip155:196",
      items: CAFE_MENU,
      quoteExpiresInSec: 300,
      note: "Demo café for governed agent spend. Paid fulfill is POST /cafe/order/latte (x402).",
    },
  };
}

/** Paid $0.04 — demo latte order voucher (matches escalate-at-3.50 story). */
export function handleCafeOrderLatte(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const buyerRef = asString(b.buyerRef ?? b.agentId, 128) ?? "anonymous";
  const orderId = `cafe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pickupCode = `UNTCH-${orderId.slice(-4).toUpperCase()}`;
  return {
    status: 200,
    body: {
      orderId,
      sku: "latte",
      itemName: "Oat latte",
      amountPaid: "4.00",
      currency: "USDT0",
      vendorId: "untch-demo-cafe",
      status: "PAID_READY_FOR_PICKUP",
      pickupCode,
      fulfillment: "DEMO_VOUCHER",
      buyerRef,
      message:
        "Show pickup code at any partner café — demo fulfillment. Real merchants can plug the same handshake.",
      paidAt: new Date().toISOString(),
    },
  };
}

// ── Launch Pack ──────────────────────────────────────────────────────────────

/** Paid $0.01 — product name suggestions (LLM when XAI_API_KEY/OPENAI_API_KEY set). */
export async function handleSuggestNames(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const idea = asString(b.idea ?? b.query ?? b.prompt, 280);
  if (!idea) {
    return { status: 400, body: errorEnvelope("IDEA_REQUIRED", "provide `idea` (string, max 280 chars)") };
  }
  const countRaw = b.count;
  const count =
    typeof countRaw === "number" && Number.isFinite(countRaw)
      ? Math.max(3, Math.min(8, Math.floor(countRaw)))
      : 6;

  const result = await suggestProductNames(idea, { count });
  return {
    status: 200,
    body: {
      idea,
      suggestions: result.suggestions,
      engine: result.engine,
      model: result.model ?? null,
      provider: result.provider ?? null,
      next: {
        checkDomains: "POST /builder/check_domains with names[]",
        rank: "POST /builder/rank_options with names[]",
        fullPack: "POST /builder/brand_pack for names+domains+rank+seo in one paid call",
      },
      note:
        result.engine === "llm"
          ? "LLM brand pack. Pair with live RDAP domain checks."
          : "Heuristic brand pack (set XAI_API_KEY or OPENAI_API_KEY for LLM names). Pair with /builder/check_domains.",
    },
  };
}

/** Free — live RDAP domain availability. */
export async function handleCheckDomains(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.names ?? b.domains;
  const bases = parseNameList(raw, 10);
  if (bases.length === 0) {
    return {
      status: 400,
      body: errorEnvelope("NAMES_REQUIRED", "provide `names` array or space/comma-separated string"),
    };
  }

  const tldInput = Array.isArray(b.tlds)
    ? b.tlds.map((t) => String(t).toLowerCase().replace(/^\.?/, ".")).filter(Boolean)
    : [...DEFAULT_TLDS];
  const tlds = (tldInput.length > 0 ? tldInput : [...DEFAULT_TLDS]).slice(0, 6);

  const domains: string[] = [];
  for (const base of bases) {
    const clean = base.toLowerCase().replace(/\.(xyz|com|ai|dev|io|org|net|app)$/i, "");
    const brand = clean.replace(/[^a-z0-9-]/g, "");
    if (!brand) continue;
    if (base.includes(".") && /\.(xyz|com|ai|dev|io|org|net|app)$/i.test(base)) {
      domains.push(base.toLowerCase());
    } else {
      for (const tld of tlds) domains.push(`${brand}${tld.startsWith(".") ? tld : `.${tld}`}`);
    }
  }

  const unique = [...new Set(domains)].slice(0, 24);
  const results = await checkDomainsLive(unique, { timeoutMs: 7_000, concurrency: 5 });

  return {
    status: 200,
    body: {
      results,
      currency: "USDT0",
      source: "rdap",
      note: "Live RDAP lookup. AVAILABLE/TAKEN when the registry answers; UNKNOWN on timeout or ambiguous response. Not a purchase or reservation.",
    },
  };
}

/** Free — rank name options by brand heuristics. */
export function handleRankOptions(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const names = parseNameList(b.names ?? b.options, 24);
  if (names.length === 0) {
    return { status: 400, body: errorEnvelope("NAMES_REQUIRED", "provide `names` string array") };
  }
  const { ranked, top } = rankBrandNames(names);
  return {
    status: 200,
    body: {
      ranked,
      top,
      note: "Heuristic rank (length, charset, pronounceability). Not trademark clearance.",
    },
  };
}

/** Free — launch checklist for a chosen name. */
export function handleSeoTips(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = asString(b.name ?? b.brand, 64);
  if (!name) {
    return { status: 400, body: errorEnvelope("NAME_REQUIRED", "provide `name` (brand string)") };
  }
  const idea = asString(b.idea ?? b.product, 200);
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    status: 200,
    body: {
      name,
      idea: idea ?? null,
      tips: [
        `Secure ${slug}.com and ${slug}.xyz before public launch.`,
        idea
          ? `Homepage hero: one sentence on the job-to-be-done for “${idea.slice(0, 80)}”.`
          : "Homepage hero: one-line job-to-be-done, not a feature list.",
        `Use “${name}” consistently in X bio, ASP listing, docs, and product chrome.`,
        "Ship a free health endpoint so agents can ping your service before paying.",
        "Publish a public receipt or demo proof page for trust.",
        "File trademark only after domain + social handles are secured in target markets.",
        "Target category keywords: agent, automation, payments, marketplace — only if true.",
      ],
      handles: {
        x: `@${slug.slice(0, 15)}`,
        domains: [`${slug}.com`, `${slug}.xyz`, `${slug}.ai`],
      },
      disclaimer: "Not legal advice. Not trademark or domain registration.",
    },
  };
}

/**
 * Paid full hireable pack: idea → names → RDAP domains → rank → SEO.
 * One agent call for the “name my product” job.
 */
export async function handleBrandPack(body: unknown): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const idea = asString(b.idea ?? b.query ?? b.prompt, 280);
  if (!idea) {
    return { status: 400, body: errorEnvelope("IDEA_REQUIRED", "provide `idea` (string, max 280 chars)") };
  }

  const named = await suggestProductNames(idea, { count: 6 });
  const nameList = named.suggestions.map((s) => s.name);
  const brandSlugs = nameList.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);

  const domains: string[] = [];
  for (const slug of brandSlugs.slice(0, 6)) {
    for (const tld of [".com", ".xyz", ".ai"]) domains.push(`${slug}${tld}`);
  }
  const domainResults = await checkDomainsLive([...new Set(domains)].slice(0, 18), {
    timeoutMs: 7_000,
    concurrency: 5,
  });

  const { ranked, top } = rankBrandNames(nameList);

  // Attach domain summary per top names
  const availableBySlug = new Map<string, string[]>();
  for (const r of domainResults) {
    if (r.status !== "AVAILABLE") continue;
    const slug = r.domain.split(".")[0] ?? "";
    const list = availableBySlug.get(slug) ?? [];
    list.push(r.domain);
    availableBySlug.set(slug, list);
  }

  const picks = ranked.slice(0, 6).map((r) => ({
    ...r,
    availableDomains: availableBySlug.get(r.name.toLowerCase().replace(/[^a-z0-9]/g, "")) ?? [],
  }));

  const topName = top ?? nameList[0] ?? "Brand";
  const seo = handleSeoTips({ name: topName, idea });
  const seoBody = seo.status === 200 ? seo.body : null;

  return {
    status: 200,
    body: {
      idea,
      engine: named.engine,
      model: named.model ?? null,
      suggestions: named.suggestions,
      ranked: picks,
      top: topName,
      domains: domainResults,
      seo: seoBody,
      currency: "USDT0",
      paidTool: "brand_pack",
      note: "Hireable launch pack: names (LLM when configured) + live RDAP + rank + SEO checklist. Not trademark clearance or domain purchase.",
    },
  };
}

/** Free catalog — what agents should list under this ASP. */
/**
 * The catalog, generated from the registry rather than typed beside it.
 *
 * WHAT IT USED TO BE
 *
 * A hand-written array of twenty-odd `{ path, price, role }` literals, grouped by an ad-hoc notion of
 * surface. It had already drifted: it advertised `GET /ping_untch` at `0.01` and
 * `POST /cafe/order/latte` at `0.04` after both had been made free, and it listed the four Bureau
 * tools at full price after they had been gated to refuse before any payment. A caller reading it
 * would have been told to expect a bill that no longer exists for services that no longer charge.
 *
 * That is the same failure the whole registry exists to end: the same contract written in two places
 * with nothing comparing them. `/catalog` is now a projection, so a price can only change here by
 * changing the one definition every other surface also reads.
 *
 * WHY IT GROUPS BY CLASS
 *
 * The old grouping — control, lifestyle, builder — described what a service was ABOUT. A caller
 * deciding whether to spend needs to know what it IS: something they can buy, something that is only
 * useful once they have an account here, or something this host will refuse them. Those are the
 * classes, so those are the groups.
 */
export function handleCatalog(): HandlerResult {
  const llm = loadLlmConfig();
  const visible = SERVICES.filter((s) => s.classification.catalogVisible);

  /**
   * A price is only shown where a caller could actually be charged it.
   *
   * The four Bureau tools carry a price in the registry and refuse before any payment challenge is
   * emitted, because they answer from history this host holds and a stranger has none. Printing
   * `$0.20` beside them would advertise a bill that cannot be incurred, which is a subtler version
   * of the same lie as charging for a simulation. They report their refusal instead.
   */
  const entry = (s: (typeof SERVICES)[number]) => {
    const chargeable =
      s.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
      s.classification.serviceClass === "ACCOUNT_CONTROL";
    return {
      toolId: s.toolId,
      path: `${s.method} ${s.path}`,
      price: s.pricing.kind === "free" ? "free" : chargeable ? s.pricing.price : "not payable",
      role: s.summary,
      schema: `https://asp.untch.xyz/schema/${s.toolId}`,
      ...(s.pricing.kind === "paid" && !chargeable
        ? { refusesWith: "REQUIRED_HISTORY_UNAVAILABLE, before any payment challenge" }
        : {}),
      ...(s.deprecated ? { deprecated: true } : {}),
    };
  };

  const inClass = (serviceClass: string) =>
    visible.filter((s) => s.classification.serviceClass === serviceClass).map(entry);

  return {
    status: 200,
    body: {
      asp: "Untch",
      baseUrl: "https://asp.untch.xyz",
      type: "A2MCP",
      surfaces: {
        /** What a stranger's agent can call and receive the promised result for. */
        marketplace: inClass("MARKETPLACE_LISTABLE"),
        /** Free discovery and health. Real, useful, and not for sale. */
        publicSupport: inClass("PUBLIC_SUPPORT"),
        /** Product APIs for operating an Untch account. Not marketplace products. */
        accountControl: inClass("ACCOUNT_CONTROL"),
        /**
         * Listed so their absence from the marketplace is visible rather than mysterious. Each one
         * refuses before any payment challenge, because a stranger cannot supply the history it needs.
         */
        internalOrWithheld: inClass("INTERNAL_OR_WITHHELD"),
        /** Present, free, and explicitly not delivering what a purchase would imply. */
        productionDisabled: inClass("PRODUCTION_DISABLED"),
      },
      launchPack: {
        llmConfigured: Boolean(llm),
        llmProvider: llm?.provider ?? null,
        naming: "Untch-style compressions (untouched→untch); AI-slop stems banned",
        hireFlow: [
          "POST /builder/brand_pack { idea } — one paid call",
          "or suggest_names → check_domains → rank_options → seo_tips",
        ],
      },
      identity: {
        registration: "GET /agent-registration.json",
        domainProof: "GET /.well-known/agent-registration.json",
        standard: "ERC-8004 registration-v1",
        network: "eip155:196",
      },
      tagline: "Agents spend. Untch keeps the mandate.",
    },
  };
}
