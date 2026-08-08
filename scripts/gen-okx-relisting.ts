/**
 * The relisting payload in OKX's OWN shape, generated from the registry.
 *
 * WHAT WAS WRONG WITH THE LIVE LISTING
 *
 * `onchainos agent service-list --agent-id 6086` shows five services, and every one of them carries a
 * TWO-line `serviceDescription`. The `agent update` contract requires FOUR for an A2MCP service and
 * says so plainly: "all FOUR REQUIRED; an A2MCP listing missing any is rejected at listing QA".
 *
 *   1. what the service does
 *   2. the parameter spec, ALL key params on ONE line, each `<name>(<type>, required/optional): <meaning>`
 *   3. the request method (POST / GET, or the MCP tool name)
 *   4. a request example — a working `curl` against the real endpoint URL
 *
 * Ours had (1) and a prose "Requires: 1. policyId 2. ..." that is not the required format, and no (3)
 * or (4) at all. Five listings, five rejections waiting.
 *
 * TWO LISTED SERVICES ARE ALSO SELLING SOMETHING THAT NO LONGER EXISTS
 *
 * `Untch cafe latte` (0.04) answers 410 SERVICE_PRODUCTION_DISABLED — it was a simulation and pricing
 * it made a demonstration look like a purchase. `Rail ping` (0.01) is now free. OKX's own validator
 * agrees: `agent x402-check` returns `valid: false` for both, and `valid: true` for the six that are
 * genuinely paid. So both are deleted rather than rewritten.
 *
 * WHY THE FREE SERVICES ARE NOT IN THIS PAYLOAD
 *
 * `rank_options`, `check_domains` and `seo_tips` are real and public, but an A2MCP entry "requires a
 * real `fee` (a plain number — an empty `fee` is rejected)". Listing a free endpoint with a price is
 * precisely the `Rail ping` mistake, and `x402-check` marks all three `valid: false` because they
 * never answer 402. They stay discoverable through `/catalog` and the MCP `tools/list`, which is where
 * a client looks for them anyway.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES } from "../services/asp/src/registry/services";
import { SETTLEMENT_TOKEN } from "../services/asp/src/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://asp.untch.xyz";
const AGENT_NAME = "Untch";

/** What is live today, from `onchainos agent service-list --agent-id 6086`. */
const LIVE: Record<string, number> = {
  "/preflight_payment": 34622,
  "/verify_delivery": 34623,
  "/cafe/order/latte": 34624,
  "/builder/brand_pack": 34625,
  "/ping_untch": 34626,
};

/** Listing names, 5–30 characters and distinct from the agent name, which the contract requires. */
const NAMES: Record<string, string> = {
  preflight_payment: "Policy preflight",
  verify_delivery: "Delivery verify",
  detect_duplicate: "Duplicate spend check",
  redact_payment_metadata: "Payment metadata redact",
  suggest_names: "Product name ideas",
  brand_pack: "Launch brand pack",
};

interface JsonSchemaish {
  readonly properties?: Record<string, { readonly type?: string; readonly description?: string }>;
  readonly required?: readonly string[];
}

/**
 * Line 2, in the exact shape the contract dictates: every key parameter on ONE line, separated by
 * `;`, each written `<name>(<type>, required/optional): <meaning>`.
 */
function parameterSpec(input: JsonSchemaish): string {
  const props = input.properties ?? {};
  const required = new Set(input.required ?? []);
  const parts = Object.entries(props).map(([name, spec]) => {
    const type = spec?.type ?? "string";
    const need = required.has(name) ? "required" : "optional";
    // Collapsed to one sentence: the whole spec must occupy a single line.
    const meaning = (spec?.description ?? name).replace(/\s+/g, " ").split(". ")[0]!.slice(0, 110);
    return `${name}(${type}, ${need}): ${meaning}`;
  });
  return parts.length > 0 ? parts.join("; ") : "no parameters";
}

/**
 * A far-future deadline, computed at generation time.
 *
 * The registry's static preflight example carried `2026-08-02`, which was already in the past by the
 * time it was read — an agent who pasted it, paid, and sent it got DEADLINE_IN_THE_PAST. Any hardcoded
 * date rots; this one is stamped a year out whenever the payload is generated.
 */
const FUTURE_DEADLINE = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();

/**
 * The example an agent actually copies, made to WORK for a session-less x402 buyer.
 *
 * Two registry examples fail on the marketplace hire path, and both were proven live:
 *
 *   • preflight_payment used `currency: "USDT0"` — only the exact settlement symbol settles, everything
 *     else is CURRENCY_NOT_SETTLEABLE — and a past `deadline`.
 *   • verify_delivery used `intentId`, which routes a caller with no session to the account-scoped
 *     handler and answers ACCOUNT_LINK_REQUIRED. The x402 hire path needs `intentHash`.
 *
 * So the example is corrected per tool rather than copied blindly. A reviewer pastes line 4; it must
 * be the call that works, not the one the docs happened to hold.
 */
function marketplaceExample(toolId: string, registryExample: Record<string, unknown>): Record<string, unknown> {
  if (toolId === "preflight_payment") {
    return { ...registryExample, currency: SETTLEMENT_TOKEN.symbol, deadline: FUTURE_DEADLINE };
  }
  if (toolId === "verify_delivery") {
    // A session-less buyer verifies by the intent's own hash, not the account-scoped intentId.
    return { intentHash: "0x" + "11".repeat(32), payload: { result: "the delivered work" } };
  }
  return registryExample;
}

/** Line 4: a curl a reviewer can paste. It must name the REAL endpoint, so it is built from one. */
function curlExample(endpoint: string, example: unknown): string {
  const body = JSON.stringify(example).replace(/"/g, '\\"');
  return `curl -X POST ${endpoint} -H "Content-Type: application/json" -d "${body}"`;
}

const listable = SERVICES.filter(
  (s) => s.classification.serviceClass === "MARKETPLACE_LISTABLE" && s.pricing.kind === "paid",
);

const services = listable.map((s) => {
  const endpoint = `${BASE}${s.path}`;
  const name = NAMES[s.toolId] ?? s.publicName;
  const description = [
    s.summary.replace(/\s+/g, " ").trim(),
    parameterSpec(s.input as JsonSchemaish),
    s.method.toUpperCase(),
    curlExample(endpoint, marketplaceExample(s.toolId, s.validExample.request as Record<string, unknown>)),
  ].join("\n");

  const existing = LIVE[s.path];
  return {
    ...(existing ? { operation: "update", id: String(existing) } : { operation: "create" }),
    serviceName: name,
    serviceDescription: description,
    serviceType: "A2MCP",
    // Plain number, USDT implied, ≤6 decimals. `$0.05` would be rejected.
    fee: String(s.pricing.price).replace(/^\$/, ""),
    endpoint,
  };
});

/** Selling a disabled simulation and a free health check. Removed, not rewritten. */
const deletions = [
  { operation: "delete", id: String(LIVE["/cafe/order/latte"]) },
  { operation: "delete", id: String(LIVE["/ping_untch"]) },
];

const payload = [...services, ...deletions];

// ── the checks the contract states, applied before anyone submits ────────────
const problems: string[] = [];
for (const s of services) {
  if (s.serviceName.length < 5 || s.serviceName.length > 30) {
    problems.push(`${s.serviceName}: name must be 5–30 characters`);
  }
  if (s.serviceName.toLowerCase() === AGENT_NAME.toLowerCase()) {
    problems.push(`${s.serviceName}: a service name must differ from the agent name`);
  }
  const lines = s.serviceDescription.split("\n");
  if (lines.length !== 4 || lines.some((l) => l.trim() === "")) {
    problems.push(`${s.serviceName}: A2MCP needs four non-empty description lines, got ${lines.length}`);
  }
  if (!lines[3]?.includes(s.endpoint)) {
    problems.push(`${s.serviceName}: the request example must use the real endpoint URL`);
  }
  if (!/^\d+(\.\d{1,6})?$/.test(s.fee)) {
    problems.push(`${s.serviceName}: fee must be a plain number with at most 6 decimals, got ${s.fee}`);
  }
  // Half-width budget; CJK counts double, and none of ours is CJK.
  if (s.serviceDescription.length > 2000) {
    problems.push(`${s.serviceName}: description exceeds 2000 half-width characters`);
  }
  /**
   * The example must be one a buyer can actually run, not just one that parses. These two are what a
   * copied example got wrong before, so they are checked by name.
   */
  const example = s.serviceDescription.split("\n")[3]!;
  if (s.endpoint.endsWith("/preflight_payment")) {
    if (!example.includes(SETTLEMENT_TOKEN.symbol)) {
      problems.push(`${s.serviceName}: example currency must be ${SETTLEMENT_TOKEN.symbol}, the only settleable symbol`);
    }
    const m = example.match(/deadline\\?":\\?"([^"\\]+)/);
    if (m && Date.parse(m[1]!) <= Date.now()) {
      problems.push(`${s.serviceName}: example deadline ${m[1]} is in the past`);
    }
  }
  if (s.endpoint.endsWith("/verify_delivery") && !example.includes("intentHash")) {
    problems.push(`${s.serviceName}: example must use intentHash — intentId needs a session a marketplace buyer has not got`);
  }
}

const target = join(HERE, "..", "services", "asp", "generated", "okx-relisting-services.json");
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`${services.length} services + ${deletions.length} deletions -> ${target}`);
for (const s of services) console.log(`  ${s.operation.padEnd(6)} ${s.serviceName.padEnd(24)} ${s.fee.padEnd(6)} ${s.endpoint}`);
if (problems.length > 0) {
  console.error("\nREFUSING: this payload would be rejected at listing QA");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nall listing-QA constraints satisfied");
