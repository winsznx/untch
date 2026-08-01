import { createServer } from "node:http";
import { createSellerApp } from "../../src/server";
import { installUnhandledRejectionGuard } from "../../src/http-errors";
import type { SellerConfig } from "../../src/config";

/**
 * Crawl every route the seller registers and report, as one JSON line, what came back.
 *
 * WHY A CHILD PROCESS
 *
 * Two reasons, and the second is the important one.
 *
 * `@okxweb3/x402-express` begins its facilitator initialisation as the middleware is constructed and
 * does not attach a handler on every path. With the facilitator unreachable, a rejection settles
 * whenever its retry budget runs out — which is after the requests that provoked it have already been
 * answered. `node:test` treats any unhandled rejection reaching the runner as a file-level failure,
 * so an in-process crawl fails on the exact condition it was written to exercise, no matter when the
 * listener is attached or removed.
 *
 * The second reason is that isolating it turns an obstacle into the assertion. If
 * `installUnhandledRejectionGuard` were absent, Node's default would TERMINATE this process when that
 * rejection lands — so a clean exit here, with rejections recorded, is direct evidence that a
 * facilitator outage cannot restart the container. That claim cannot be made from inside a runner
 * that installs its own handler.
 *
 * The facilitator points at a closed loopback port on purpose: it is the failure mode that made
 * `/preflight_payment` — one of the two services OKX rejected — answer an HTML 500 with a stack trace
 * naming the x402 package's internals. It also fails in microseconds rather than waiting out DNS and
 * TLS, which keeps the crawl deterministic.
 */

const FAKE_CONFIG: SellerConfig = {
  okxApiKey: "test-key",
  okxSecretKey: "test-secret",
  okxPassphrase: "test-passphrase",
  payTo: "0x000000000000000000000000000000000000dEaD",
  port: 0,
};

const rejections: string[] = [];
installUnhandledRejectionGuard((line) => rejections.push(line));

process.env.OKX_X402_FACILITATOR_URL = "http://127.0.0.1:1";

interface RouteLayer {
  readonly route?: { readonly path: string | readonly string[]; readonly methods: Record<string, boolean> };
}

const app = createSellerApp(FAKE_CONFIG);

const targets: Array<{ method: string; path: string }> = [];
const router = (app as unknown as { _router?: { stack: readonly RouteLayer[] } })._router;
for (const layer of router?.stack ?? []) {
  if (!layer.route) continue;
  const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path as string];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const concrete = p.replace(/:[A-Za-z0-9_]+/g, "crawl-probe");
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) targets.push({ method: method.toUpperCase(), path: concrete });
    }
  }
}

const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address() as { port: number };
const base = `http://127.0.0.1:${addr.port}`;

/**
 * Empty bodies on purpose.
 *
 * An empty body is the request a confused caller actually sends, and it is the one that used to reach
 * Express's default handler. It is also network-safe: every handler that would call out — the RDAP
 * domain check, the LLM namer — validates its input first and returns 400, or sits behind the payment
 * gate and never runs.
 */
const nonJson: string[] = [];
const statuses: Record<string, number> = {};

for (const { method, path } of targets) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  statuses[`${method} ${path}`] = res.status;
  if (method === "HEAD") continue; // no body by definition
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) nonJson.push(`${method} ${path} → ${res.status} ${type}`);
}

/** The specific requests the audit named, captured with their bodies so assertions can read them. */
async function probe(method: string, path: string, body?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    allow: res.headers.get("allow"),
    body: await res.text(),
  };
}

const probes = {
  unmatched: await probe("GET", "/no/such/route"),
  advertisedWrongVerb: await probe("GET", "/consumer/auth/nonce"),
  malformedBody: await probe("POST", "/get_ledger", "{not json"),
  pricedWithDeadFacilitator: await probe("POST", "/preflight_payment", "{}"),
};

/**
 * Wait past the middleware's retry budget (3 attempts, 1s backoff) so the stray rejection lands while
 * this process is still running. Exiting before it settles would report a survival this run did not
 * actually demonstrate.
 */
await new Promise((resolve) => setTimeout(resolve, 4000));

await new Promise<void>((resolve) => server.close(() => resolve()));

process.stdout.write(
  `${JSON.stringify({
    targets: targets.length,
    nonJson,
    statuses,
    probes,
    rejectionsSurvived: rejections.length,
  })}\n`,
);
process.exit(0);
