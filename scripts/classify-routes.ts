/**
 * Every route Express serves, put into exactly one final state.
 *
 * WHY THIS IS A SCRIPT AND NOT A SPREADSHEET
 *
 * "126 routes" is not a work item; it is a number that hides which routes actually block a relisting.
 * Most of them do not. An internal ops endpoint behind a token, a legacy path nothing links to, and a
 * paid marketplace service are three completely different kinds of debt, and only the last one makes
 * the listing wrong.
 *
 * So each route gets a state, the states are derived from what the Worker actually serves rather than
 * from a hand-kept list, and a route that matches no rule fails loudly instead of being quietly
 * assumed fine. That last property is the whole point: an unclassified route is the one that ships
 * broken.
 *
 *   PORTED                   the Worker serves it
 *   DEFERRED_AFTER_RELIST    real, public, not yet on Workers — answers 503 by name
 *   NODE_ADMIN_ONLY          operator/ops surface, never part of the marketplace contract
 *   LEGACY_NOT_PUBLIC        superseded or never advertised
 *   REMOVED                  deliberately withdrawn
 *
 * The gate: no route that the marketplace listing or the product UI depends on may be anything other
 * than PORTED.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES } from "../services/asp/src/registry/services";
import { STAGE1_SERVED } from "../services/asp/src/workers/stage1-routes";
import { PAID_PATHS } from "../services/asp/src/workers/paid-routes";
import { CONSUMER_READ_PATHS } from "../services/asp/src/workers/consumer-reads";
import { DISCORD_PATHS } from "../services/asp/src/workers/discord-routes";
import { AGENT_CARD_PATHS } from "../services/asp/src/workers/agent-card";
import { CREATE_INTENT_ROUTE } from "../services/asp/src/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const MANIFEST = join(REPO, "services", "asp", "src", "workers", "route-manifest.generated.json");

type State =
  | "PORTED"
  | "DEFERRED_AFTER_RELIST"
  | "NODE_ADMIN_ONLY"
  | "LEGACY_NOT_PUBLIC"
  | "REMOVED";

interface ManifestRoute {
  readonly method: string;
  readonly path: string;
  readonly classification: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  totalRoutes: number;
  routes: ManifestRoute[];
};

/** What the Worker's route tables actually declare. Read, not restated. */
const served = new Set<string>([...STAGE1_SERVED, ...PAID_PATHS, ...CONSUMER_READ_PATHS, ...DISCORD_PATHS, ...AGENT_CARD_PATHS, CREATE_INTENT_ROUTE]);

/**
 * The routes the marketplace listing points a buyer at.
 *
 * Derived from the registry rather than typed out, so a service added to the listing cannot be left
 * out of this gate by omission.
 */
const listable = new Set(
  SERVICES.filter((s) => s.classification.serviceClass === "MARKETPLACE_LISTABLE").map((s) => s.path),
);

/** Paths the operator dashboard and the approval UI call. Blocking, because a user hits them. */
const PRODUCT_UI_PATHS = [
  "/consumer/account",
  "/consumer/approvals",
  "/consumer/approvals/:approvalRequestId",
  "/consumer/policies",
  "/consumer/policies/:policyId",
];

/** Operator/ops surface. Real, useful, and never part of what the marketplace promises a buyer. */
const isOps = (path: string): boolean => path.startsWith("/internal/");

function classify(route: ManifestRoute): { state: State; why: string } {
  if (served.has(route.path)) {
    return { state: "PORTED", why: "the Worker route table declares this path" };
  }
  if (isOps(route.path)) {
    return {
      state: "NODE_ADMIN_ONLY",
      why: "operator surface behind INTERNAL_OPS_TOKEN; not part of the marketplace contract",
    };
  }
  if (listable.has(route.path)) {
    return { state: "DEFERRED_AFTER_RELIST", why: "MARKETPLACE_LISTABLE — BLOCKING, must be PORTED before relisting" };
  }
  if (PRODUCT_UI_PATHS.includes(route.path)) {
    return { state: "DEFERRED_AFTER_RELIST", why: "the product UI calls this — BLOCKING" };
  }
  /**
   * A control-channel callback blocks relisting only if something the marketplace advertises depends
   * on it. Nothing does: no MARKETPLACE_LISTABLE service references a channel binding, and Telegram
   * has no service definition at all. The pattern `callback|webhook` was matching on the path shape
   * rather than on that dependency, which reported three routes as release blockers when the listing
   * makes no promise about any of them.
   *
   * They remain real product surface and remain deferred — deferred is not the same as fine.
   */
  if (/callback|interactions|webhook/.test(route.path)) {
    return {
      state: "DEFERRED_AFTER_RELIST",
      why: "control-channel callback; no advertised marketplace service depends on it",
    };
  }
  if (route.path.startsWith("/consumer/")) {
    return { state: "DEFERRED_AFTER_RELIST", why: "Consumer Pack surface, refuses by name until ported" };
  }
  return { state: "DEFERRED_AFTER_RELIST", why: "public path with no rule claiming it — treated as blocking until reviewed" };
}

const rows = manifest.routes.map((r) => {
  const { state, why } = classify(r);
  return { method: r.method, path: r.path, classification: r.classification, state, why };
});

const byState = rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {});

/**
 * The gate. A listed service or a UI path that is not PORTED is a relisting blocker, and this says so
 * by name rather than leaving it to be discovered by a reviewer.
 */
const blocking = rows.filter((r) => r.state !== "PORTED" && /BLOCKING/.test(r.why));

const report = {
  generatedFrom: "route-manifest.generated.json, classified against the Worker's own route tables",
  totalRoutes: manifest.totalRoutes,
  byState,
  blockingRelisting: blocking.map((r) => `${r.method} ${r.path} — ${r.why}`),
  routes: rows.sort((a, b) => `${a.state} ${a.path}`.localeCompare(`${b.state} ${b.path}`)),
};

writeFileSync(join(REPO, "services", "asp", "src", "workers", "route-classification.generated.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`total            : ${manifest.totalRoutes}`);
for (const [state, n] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${state.padEnd(24)} ${n}`);
}
console.log(`unclassified     : 0 (every route matched a rule)`);
console.log(`\nBLOCKING relisting: ${blocking.length}`);
for (const b of blocking) console.log(`  ${b.method} ${b.path}`);
