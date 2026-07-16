/**
 * Consumer / lifestyle / builder ASP tools — thin, deterministic, x402-priced.
 * These are real HTTP services agents can call; external fulfillment (Purch, registrars)
 * can replace stubs later without changing the Untch preflight surface.
 */

import type { HandlerResult } from "./handlers";

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

function asString(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
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
      message: "Show pickup code at any partner café — demo fulfillment. Real merchants can plug the same handshake.",
      paidAt: new Date().toISOString(),
    },
  };
}

// ── Launch / builder pack ────────────────────────────────────────────────────

const ADJECTIVES = [
  "bright", "clear", "swift", "quiet", "solid", "open", "north", "prime", "true", "field",
  "signal", "harbor", "ledger", "pulse", "forge", "anchor", "relay", "vault", "orbit", "grain",
];
const NOUNS = [
  "kit", "lab", "works", "desk", "node", "base", "line", "stack", "craft", "gate",
  "lane", "mill", "yard", "form", "loop", "path", "dock", "grid", "core", "wave",
];

/** Paid $0.01 — suggest product names from an idea string (deterministic, no LLM). */
export function handleSuggestNames(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const idea = asString(b.idea ?? b.query ?? b.prompt, 200);
  if (!idea) {
    return { status: 400, body: errorEnvelope("IDEA_REQUIRED", "provide `idea` (string, max 200 chars)") };
  }
  const seed = [...idea.toLowerCase()].reduce((a, c) => a + c.charCodeAt(0), 0);
  const words = idea.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const stem = (words[0] ?? "untch").slice(0, 8);
  const names: string[] = [];
  for (let i = 0; i < 8; i++) {
    const a = ADJECTIVES[(seed + i * 7) % ADJECTIVES.length];
    const n = NOUNS[(seed + i * 13) % NOUNS.length];
    names.push(i % 2 === 0 ? `${stem}${n}` : `${a}${stem}`);
  }
  // unique, title-ish
  const unique = [...new Set(names)].slice(0, 6).map((n) => n.charAt(0).toUpperCase() + n.slice(1));
  return {
    status: 200,
    body: {
      idea,
      suggestions: unique.map((name, i) => ({
        name,
        score: 90 - i * 7,
        style: i % 2 === 0 ? "compound" : "adjective-stem",
      })),
      note: "Deterministic name pack for agent builders. Pair with /builder/check_domains.",
    },
  };
}

/** Free — RDAP-style domain availability stubs (honest demo; replace with live registrar later). */
export function handleCheckDomains(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.names ?? b.domains;
  const names: string[] = Array.isArray(raw)
    ? raw.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 12)
    : typeof raw === "string"
      ? raw.split(/[,\s]+/).map((s) => s.toLowerCase().trim()).filter(Boolean).slice(0, 12)
      : [];
  if (names.length === 0) {
    return { status: 400, body: errorEnvelope("NAMES_REQUIRED", "provide `names` array or space/comma-separated string") };
  }
  const tlds = [".xyz", ".com", ".ai", ".dev"];
  const results = names.flatMap((base) => {
    const clean = base.replace(/\.(xyz|com|ai|dev)$/i, "");
    return tlds.map((tld) => {
      const domain = `${clean}${tld}`;
      // deterministic pseudo-availability from hash of domain
      const h = [...domain].reduce((a, c) => a + c.charCodeAt(0), 0);
      const available = h % 5 !== 0;
      const premium = h % 11 === 0;
      return {
        domain,
        available,
        premium,
        priceUsdt: available ? (premium ? "18.00" : "9.99") : null,
        status: available ? (premium ? "AVAILABLE_PREMIUM" : "AVAILABLE") : "TAKEN",
      };
    });
  });
  return {
    status: 200,
    body: {
      results,
      currency: "USDT0",
      note: "Demo availability model (deterministic). Live registrar API can replace this without changing the tool contract.",
    },
  };
}

/** Free — rank name options by simple heuristics. */
export function handleRankOptions(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.names ?? b.options;
  const names: string[] = Array.isArray(raw) ? raw.map(String).filter(Boolean).slice(0, 20) : [];
  if (names.length === 0) {
    return { status: 400, body: errorEnvelope("NAMES_REQUIRED", "provide `names` string array") };
  }
  const ranked = names
    .map((name) => {
      const len = name.length;
      const lengthScore = len >= 5 && len <= 10 ? 40 : len < 5 ? 20 : 25;
      const alpha = /^[a-zA-Z]+$/.test(name) ? 30 : 15;
      const noHyphen = name.includes("-") ? 0 : 15;
      const score = lengthScore + alpha + noHyphen + (name.length % 7);
      return { name, score, reasons: ["length", "charset", "hyphen"].filter(Boolean) };
    })
    .sort((a, b) => b.score - a.score);
  return { status: 200, body: { ranked, top: ranked[0]?.name ?? null } };
}

/** Free — SEO / launch checklist tips for a chosen name. */
export function handleSeoTips(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = asString(b.name ?? b.brand, 64);
  if (!name) {
    return { status: 400, body: errorEnvelope("NAME_REQUIRED", "provide `name` (brand string)") };
  }
  return {
    status: 200,
    body: {
      name,
      tips: [
        `Claim ${name.toLowerCase()}.xyz or .com before marketing.`,
        "Write a one-line job-to-be-done on the homepage hero.",
        "Publish a public receipt or demo proof page for trust.",
        "Use the brand name consistently in X bio, ASP listing, and docs.",
        "Target category keywords: agent, payments, automation, marketplace.",
        "Ship a free ping tool so agents can health-check your ASP.",
      ],
    },
  };
}

/** Free catalog — what agents should list under this ASP. */
export function handleCatalog(): HandlerResult {
  return {
    status: 200,
    body: {
      asp: "Untch",
      baseUrl: "https://asp.untch.xyz",
      type: "A2MCP",
      surfaces: {
        control: [
          { path: "GET /ping_untch", price: "0.01", role: "health / rail proof" },
          { path: "POST /create_spend_intent", price: "bundled", role: "bound intent" },
          { path: "POST /preflight_payment", price: "0.05", role: "policy gate" },
          { path: "POST /verify_delivery", price: "0.10", role: "T0 proof" },
          { path: "POST /score_vendor", price: "0.20", role: "bureau" },
          { path: "POST /score_buyer", price: "0.20", role: "bureau" },
          { path: "POST /generate_dispute_packet", price: "0.50", role: "reports" },
          { path: "POST /reconcile_agent_spend", price: "0.25", role: "reports" },
        ],
        lifestyle: [
          { path: "GET /cafe/menu", price: "free", role: "coffee catalog" },
          { path: "POST /cafe/order/latte", price: "0.04", role: "demo coffee voucher" },
        ],
        builder: [
          { path: "POST /builder/suggest_names", price: "0.01", role: "name ideas" },
          { path: "POST /builder/check_domains", price: "free", role: "domain options" },
          { path: "POST /builder/rank_options", price: "free", role: "rank names" },
          { path: "POST /builder/seo_tips", price: "free", role: "launch tips" },
        ],
      },
      tagline: "Agents spend. Untch keeps the mandate.",
    },
  };
}
