/**
 * The canonical route inventory, read from a REAL Express app rather than parsed out of the source.
 *
 * WHY NOT STATIC ANALYSIS
 *
 * The first version of this script scanned `app.<method>(CONSTANT` and found 74 routes against 116
 * route constants. The gap was not dead code: `consumer/routes.ts`, `policy-routes.ts` and
 * `account-routes.ts` register through loop variables — `for (const path of PATHS) app.post(path, …)`
 * — so the constant never appears at the call site. A regex would have declared 44 live routes absent,
 * which during a transport migration means 44 endpoints that quietly 404 after cutover.
 *
 * So the app is CONSTRUCTED and its router stack walked. That is ground truth: whatever Express will
 * actually serve is what gets listed, including routes mounted by a helper, a loop or a table.
 *
 * WHAT THE MANIFEST IS FOR
 *
 * The Workers router, the parity harness and CI all validate against this one file. Every route must
 * end in exactly one final state, and a route in DEFERRED_BLOCKING_CUTOVER blocks the custom domain.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createSellerApp } from "../services/asp/src/server";
import { initPolicyWiring } from "../services/asp/src/policy-wiring";
import { initConsumerWiring } from "../services/asp/src/consumer/wiring";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

export type RouteState =
  | "PORTED"
  | "INTENTIONALLY_NODE_ONLY"
  | "REMOVED_WITH_DOCUMENTED_REASON"
  | "INTERNAL_NOT_PUBLIC"
  | "DEFERRED_BLOCKING_CUTOVER";

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: { name: string }[] };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp;
}

/** Walk the Express router stack, including nested routers. */
function collect(stack: Layer[], out: { method: string; path: string; handlers: string[] }[] = []): typeof out {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const handlers = layer.route.stack.map((s) => s.name || "anonymous");
      for (const p of paths) {
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (on) out.push({ method: method.toUpperCase(), path: p, handlers });
        }
      }
    } else if (layer.handle?.stack) {
      collect(layer.handle.stack, out);
    }
  }
  return out;
}

function classify(path: string): string {
  if (path.startsWith("/internal/")) return "internal";
  if (/callback|interactions|webhook/.test(path)) return "callback";
  if (path.startsWith("/consumer/account") || path.startsWith("/consumer/approvals") || path.startsWith("/consumer/policies")) {
    return "account";
  }
  if (/^\/(ping_untch|catalog|openapi|healthz|readyz|\.well-known)/.test(path) || path === "/consumer/catalog") return "public";
  return "marketplace";
}

/**
 * Body mode from the handler chain Express actually mounted.
 *
 * `express.raw` appears in the stack as `raw`; `express.json` as `jsonParser`; urlencoded as
 * `urlencodedParser`. Reading the mounted chain is stronger than guessing from the path, and it is how
 * the Discord route is proven to be the raw one.
 */
function bodyMode(method: string, handlers: readonly string[]): "raw" | "json" | "form" | "none" {
  // Express names its parsers rawParser / jsonParser / urlencodedParser. Matching `^raw$` found
  // nothing and reported zero raw-body routes, which for the Discord endpoint is the exact wrong
  // answer — so the names are matched as Express actually emits them.
  if (handlers.some((h) => /^rawParser$/.test(h))) return "raw";
  if (handlers.some((h) => /urlencoded/i.test(h))) return "form";
  if (handlers.some((h) => /^jsonParser$/.test(h))) return "json";
  return method === "GET" || method === "DELETE" ? "none" : "json";
}

/**
 * The payment middleware calls the OKX facilitator on first initialisation. That is correct at
 * runtime and irrelevant here: the router stack is complete the moment `createSellerApp` returns, and
 * the manifest is written synchronously after it. The rejection is swallowed so a network timeout
 * cannot kill a generator that has already got what it needs — and CI can run this offline.
 */
process.on("unhandledRejection", () => {});

// Minimal environment: the app must construct without reaching a database, a facilitator or a wallet.
process.env.OKX_API_KEY ??= "manifest-generation-only";
process.env.OKX_SECRET_KEY ??= "manifest-generation-only";
process.env.OKX_PASSPHRASE ??= "manifest-generation-only";
process.env.PAY_TO_ADDRESS ??= "0x0000000000000000000000000000000000000000";
process.env.BUYER_PRIVATE_KEY ??= `0x${"11".repeat(32)}`;

/**
 * Constructed WITH wiring.
 *
 * `createSellerApp` takes the wirings as arguments, and several route groups register an
 * `unavailable` stub when theirs is null — the approval-action surface needs a store, a session
 * secret AND a policy provider. Generating from an unwired app reported five routes with no body
 * mode, which for `/consumer/approvals/action/:id/confirm` (urlencoded + json) is the wrong answer.
 * So the manifest is generated against real wiring, and `stubbedDuringGeneration` stays as the
 * honest signal if any group still fails to mount.
 */
const [policyWiring, consumerWiring] = await Promise.all([
  initPolicyWiring().catch(() => null),
  initConsumerWiring({ log: () => {} }).catch(() => null),
]);

const app = createSellerApp(undefined, null, policyWiring, null, null, null, consumerWiring);
const stack = ((app as unknown as { _router?: { stack: Layer[] }; router?: { stack: Layer[] } })._router
  ?? (app as unknown as { router: { stack: Layer[] } }).router).stack;

const found = collect(stack);

/** One record per method+path. A path registered twice keeps the raw registration. */
const seen = new Map<string, { method: string; path: string; handlers: string[] }>();
for (const r of found) {
  const key = `${r.method} ${r.path}`;
  const prev = seen.get(key);
  if (!prev || (bodyMode(prev.method, prev.handlers) !== "raw" && bodyMode(r.method, r.handlers) === "raw")) {
    seen.set(key, r);
  }
}

const routes = [...seen.values()]
  .map((r) => ({
    method: r.method,
    path: r.path,
    bodyMode: bodyMode(r.method, r.handlers),
    rawBodyRequired: bodyMode(r.method, r.handlers) === "raw",
    handlers: r.handlers,
    /**
     * True when the app mounted the "unavailable" stub instead of the real handler, which happens
     * when a dependency (database, session secret, provider) was absent at construction. Recorded
     * rather than hidden: a manifest generated from a half-wired app would understate body modes.
     */
    wiredStub: r.handlers.some((h) => /^unavailable$/.test(h)),
    pathParams: [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!),
    classification: classify(r.path),
    /** Filled from the canonical service registry in a later pass; never guessed here. */
    payable: "unclassified" as const,
    discoverable: false,
    state: "DEFERRED_BLOCKING_CUTOVER" as RouteState,
    notes: null as string | null,
  }))
  .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));

const manifest = {
  generatedFrom: "a constructed Express app's router stack (ground truth, not static analysis)",
  generator: "scripts/gen-route-manifest.ts",
  totalRoutes: routes.length,
  byMethod: routes.reduce<Record<string, number>>((a, r) => ({ ...a, [r.method]: (a[r.method] ?? 0) + 1 }), {}),
  byClassification: routes.reduce<Record<string, number>>((a, r) => ({ ...a, [r.classification]: (a[r.classification] ?? 0) + 1 }), {}),
  byState: routes.reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {}),
  rawBodyRoutes: routes.filter((r) => r.rawBodyRequired).map((r) => `${r.method} ${r.path}`),
  /** Routes whose real handler did not mount because a dependency was missing during generation. */
  stubbedDuringGeneration: routes.filter((r) => r.wiredStub).map((r) => `${r.method} ${r.path}`),
  routes,
};

const target = join(REPO, "services", "asp", "src", "workers", "route-manifest.generated.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`routes            : ${routes.length}`);
console.log(`by method         : ${JSON.stringify(manifest.byMethod)}`);
console.log(`by classification : ${JSON.stringify(manifest.byClassification)}`);
console.log(`raw-body routes   : ${manifest.rawBodyRoutes.join(", ") || "(none)"}`);
console.log(`stubbed (unwired) : ${manifest.stubbedDuringGeneration.length}`);
console.log(`written           : ${relative(REPO, target)}`);

// The facilitator's init promise may still be pending; nothing here needs it.
process.exit(0);
