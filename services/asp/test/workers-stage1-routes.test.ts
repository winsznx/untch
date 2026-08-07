import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { NETWORK, SETTLEMENT_TOKEN } from "../src/config";
import { ERC8004_AGENT_ID } from "../src/registry/marketplace-identity";
import { createSellerApp } from "../src/server";
import { armingState } from "../src/workers/arming";
import type { RouteContext } from "../src/workers/entry";
import { dispatch, WorkersRouter, type Route } from "../src/workers/router";
import { stage1Fallback, stage1Routes, STAGE1_SERVED, type Stage1Settlement } from "../src/workers/stage1-routes";
import { writerGate } from "../src/workers/writer-gate";
import manifest from "../src/workers/route-manifest.generated.json";
import { startFacilitatorStub, type FacilitatorStub } from "./fixtures/facilitator-stub";

/**
 * The Stage 1 surface, checked against the Express app it replaces.
 *
 * WHY THIS RUNS A REAL EXPRESS SERVER
 *
 * The Worker and Express both build their discovery documents from the registry, so a test that
 * compared each against the registry would pass while they diverged from each other. The only
 * comparison that means anything is document-to-document: start the real app, fetch `/catalog`,
 * `/schema`, `/openapi.json` and `/.well-known/x402`, and require the Worker to produce the same
 * bytes for the same base URL.
 *
 * WHAT THE SUITE IS REALLY DEFENDING
 *
 * Two things a marketplace validator would punish. First, a discovery document whose contents shifted
 * during a transport migration — a price, a schema URL or a payee that changed because it was written
 * twice. Second, an unported route answering as though it had been withdrawn. During the migration
 * "not here yet" and "does not exist" are different facts, and collapsing them is what turns a
 * partial cutover into an apparent delisting.
 */

const PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";
const BASE = "https://asp.untch.xyz";

/**
 * Read from config, not retyped.
 *
 * The first version of this file spelled the asset out by hand as `USDT0` at a lowercase address, and
 * the parity check caught it against the canonical `USD₮` at the checksummed one. That is the failure
 * mode the suite exists to find, and a test that hardcodes the same values it is checking cannot find
 * it — so the Worker and the test read the same constants the Express app does.
 */
const SETTLEMENT: Stage1Settlement = {
  network: NETWORK,
  payTo: PAY_TO,
  asset: {
    symbol: SETTLEMENT_TOKEN.symbol,
    address: SETTLEMENT_TOKEN.address,
    decimals: SETTLEMENT_TOKEN.decimals,
  },
};

let server: Server | null = null;
let facilitator: FacilitatorStub | null = null;
let expressBase = "";
const restoreEnv: Record<string, string | undefined> = {};

/** Set an env var for the run and remember what to put back, so suites cannot leak into each other. */
function setEnv(name: string, value: string): void {
  restoreEnv[name] = process.env[name];
  process.env[name] = value;
}

before(async () => {
  facilitator = await startFacilitatorStub();
  process.env.OKX_X402_FACILITATOR_URL = facilitator.url;
  // Express derives its published base URL from this. Both sides must publish the same one or every
  // document differs on every URL for a reason that has nothing to do with parity.
  setEnv("ASP_PUBLIC_URL", BASE);
  /**
   * The registration card reads its agent id from the environment, and production Railway sets it.
   * Without it here Express would render a card with no on-chain registration while the Worker renders
   * the real one, and the comparison would measure the test harness rather than the two transports.
   */
  setEnv("ERC8004_AGENT_ID", String(ERC8004_AGENT_ID));

  const app = createSellerApp({
    okxApiKey: "test-api-key",
    okxSecretKey: "test-secret-key",
    okxPassphrase: "test-passphrase",
    payTo: PAY_TO as `0x${string}`,
    port: 0,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bound port");
  // production-surface-allow: localhost — an ephemeral in-test listener, never a published URL.
  expressBase = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  delete process.env.OKX_X402_FACILITATOR_URL;
  for (const [name, previous] of Object.entries(restoreEnv)) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (facilitator) await facilitator.close();
});

/** A route context with the posture a Stage 1 production deployment actually ships in. */
function ctx(over: Partial<RouteContext> = {}): RouteContext {
  const schema = { ok: true as const, applied: 35, head: "035_wallet_scope_downgrade.sql" };
  return {
    pool: null as never,
    env: { UNTCH_ENVIRONMENT: "production", ASP_PUBLIC_URL: BASE } as never,
    arming: armingState({ attested: false, schema, armedFlag: "0" }),
    gate: writerGate("0"),
    baseUrl: BASE,
    schema,
    ...over,
  };
}

function routerFor(context: RouteContext = ctx()): WorkersRouter {
  return new WorkersRouter().addAll(stage1Routes(context, SETTLEMENT));
}

async function workerGet(path: string, context: RouteContext = ctx()): Promise<Response> {
  return dispatch(routerFor(context), new Request(`${BASE}${path}`, { method: "GET" }), {
    onNotFound: stage1Fallback,
  });
}

const expressGet = async (path: string): Promise<Response> => fetch(`${expressBase}${path}`);

/**
 * The Worker adds a `deployment` block that Express has no reason to carry: it names which paths this
 * particular deployment can serve today. Stripped before comparison, and asserted separately, so the
 * parity check covers every canonical field and the annotation cannot be used to hide a difference.
 */
function withoutDeploymentNote(body: Record<string, unknown>): Record<string, unknown> {
  const { deployment: _deployment, ...rest } = body;
  return rest;
}

describe("the discovery documents are the same on both transports", () => {
  const DOCUMENTS = ["/catalog", "/schema", "/openapi.json", "/.well-known/x402"] as const;

  for (const path of DOCUMENTS) {
    test(`${path} is byte-identical to the Express document`, async () => {
      const [fromExpress, fromWorker] = await Promise.all([expressGet(path), workerGet(path)]);

      assert.equal(fromExpress.status, 200, `Express must serve ${path}`);
      assert.equal(fromWorker.status, 200, `the Worker must serve ${path}`);

      const expected = (await fromExpress.json()) as Record<string, unknown>;
      const actual = withoutDeploymentNote((await fromWorker.json()) as Record<string, unknown>);

      assert.deepEqual(
        actual,
        expected,
        `${path} differs between Express and the Worker. A discovery document written twice is the ` +
          "failure the registry exists to prevent — fix the shared builder, never the copy.",
      );
    });
  }

  test("one service contract is identical, parameters and all", async () => {
    const [fromExpress, fromWorker] = await Promise.all([
      expressGet("/schema/verify_delivery"),
      workerGet("/schema/verify_delivery"),
    ]);
    assert.equal(fromExpress.status, 200);
    assert.equal(fromWorker.status, 200);
    assert.deepEqual(await fromWorker.json(), await fromExpress.json());
  });

  test("an unknown tool refuses the same way on both", async () => {
    const [fromExpress, fromWorker] = await Promise.all([
      expressGet("/schema/not_a_tool"),
      workerGet("/schema/not_a_tool"),
    ]);
    assert.equal(fromExpress.status, 404);
    assert.equal(fromWorker.status, 404);
    assert.equal(((await fromWorker.json()) as { code: string }).code, "TOOL_NOT_FOUND");
  });

  test("the ERC-8004 card resolves at both paths the marketplace may read", async () => {
    for (const path of ["/agent-registration.json", "/.well-known/agent-registration.json"]) {
      const [fromExpress, fromWorker] = await Promise.all([expressGet(path), workerGet(path)]);
      assert.equal(fromExpress.status, 200, `Express serves ${path}`);
      assert.equal(fromWorker.status, 200, `the Worker must serve ${path}`);
      assert.deepEqual(await fromWorker.json(), await fromExpress.json(), path);
    }
  });
});

describe("the published payee is the committed one", () => {
  /**
   * The single field in the whole surface that, if wrong, sends money somewhere Untch does not
   * control. Asserted against the literal rather than against the settlement object the test passes
   * in, so a typo in either place fails.
   */
  test("the x402 document names the role address, not a placeholder", async () => {
    const body = (await (await workerGet("/.well-known/x402")).json()) as { payTo: string };
    assert.equal(body.payTo, PAY_TO);
    assert.notEqual(body.payTo, `0x${"0".repeat(40)}`);
  });
});

describe("the table serves exactly what it claims to serve", () => {
  test("every route in the table is declared served, and every declared path is routable", () => {
    const patterns = new Set(routerFor().allRoutes().map((r) => (r as Route).pattern));
    for (const pattern of patterns) {
      assert.ok(STAGE1_SERVED.has(pattern), `${pattern} is routable but not declared in STAGE1_SERVED`);
    }
    for (const declared of STAGE1_SERVED) {
      assert.ok(patterns.has(declared), `${declared} is declared served but no route answers it`);
    }
  });

  /**
   * THE PROPERTY THAT KEEPS THIS DEPLOYMENT FROM TAKING MONEY.
   *
   * Nothing in Stage 1 is priced, so the payment gate has nothing to wrap. A route marked `priced`
   * here would emit a 402 — an invitation to pay — for a handler that cannot deliver.
   */
  test("no Stage 1 route is priced", () => {
    for (const route of routerFor().allRoutes()) {
      assert.notEqual(route.priced, true, `${route.pattern} must not be priced before its handler is ported`);
    }
  });

  test("no Stage 1 route reads a request body", () => {
    for (const route of routerFor().allRoutes()) {
      assert.equal(route.bodyMode, "none", `${route.pattern} takes no input, so it must not touch the stream`);
    }
  });

  /**
   * `/readyz` and `/internal/deployment` are the two routes that exist only here. They describe the
   * Worker's own posture — schema verification, arming, write ownership — which is a Cloudflare-shaped
   * question Express never had to answer. Everything else must be a path Express really serves, or it
   * is an endpoint this migration invented.
   */
  test("every served path is a path Express also serves", () => {
    const express = new Set(manifest.routes.map((r) => r.path));
    const workerOnly = new Set(["/readyz", "/internal/deployment"]);
    for (const declared of STAGE1_SERVED) {
      if (workerOnly.has(declared)) continue;
      assert.ok(express.has(declared), `${declared} is served here but Express has no such route — an invented endpoint`);
    }
  });
});

describe("a marketplace validator probing a listed service gets the Express answer", () => {
  /**
   * The probe a validator actually runs against a listed paid endpoint. A 404 here reads as a
   * delisting and a 503 reads as an outage, so both transports must say the same thing: the endpoint
   * is real, and it takes POST.
   */
  test("the free probe answers 405 USE_POST, exactly as Express does", async () => {
    const [fromExpress, fromWorker] = await Promise.all([
      expressGet("/cafe/order/latte"),
      workerGet("/cafe/order/latte"),
    ]);
    assert.equal(fromExpress.status, 405);
    assert.equal(fromWorker.status, 405);
    assert.deepEqual(await fromWorker.json(), await fromExpress.json());
  });

  /**
   * THE ONE PLACE STAGE 1 DELIBERATELY DOES NOT MATCH EXPRESS.
   *
   * The priced probes sit behind the payment middleware, so Express answers a GET to them with a live
   * 402 challenge. Reproducing that here would invite a caller to pay for a handler this deployment
   * has not ported — the refusal has to come first, and 503 is the refusal that asks for no money.
   */
  for (const path of ["/preflight_payment", "/verify_delivery", "/builder/brand_pack"]) {
    test(`GET ${path} refuses without a challenge, where Express would charge for the probe`, async () => {
      const fromExpress = await expressGet(path);
      assert.equal(fromExpress.status, 402, "Express prices this probe; that is the behaviour being deferred");

      const fromWorker = await workerGet(path);
      assert.equal(fromWorker.status, 503);
      assert.equal(fromWorker.headers.get("retry-after"), "300");
      assert.equal(fromWorker.headers.get("payment-required"), null);
      assert.equal(((await fromWorker.json()) as { code: string }).code, "SERVICE_TEMPORARILY_UNAVAILABLE");
    });
  }

  test("the free liveness tool answers on both", async () => {
    const [fromExpress, fromWorker] = await Promise.all([expressGet("/ping_untch"), workerGet("/ping_untch")]);
    assert.equal(fromExpress.status, 200);
    assert.equal(fromWorker.status, 200);
    // `ts` is a timestamp and cannot match; everything that is a contract must.
    const { ts: _e, ...expected } = (await fromExpress.json()) as Record<string, unknown>;
    const { ts: _w, ...actual } = (await fromWorker.json()) as Record<string, unknown>;
    assert.deepEqual(actual, expected);
  });
});

describe("an unported route says it is coming back, not that it is gone", () => {
  /** The (method, pattern) pairs the Worker actually answers. Path alone is not enough: GET on a
   *  business route is served while POST on the same path is not. */
  const servedPairs = new Set(routerFor().allRoutes().map((r) => `${r.method} ${r.pattern}`));

  test("an unported paid route answers 503, not 404", async () => {
    const res = await dispatch(routerFor(), new Request(`${BASE}/verify_delivery`, { method: "POST" }), {
      onNotFound: stage1Fallback,
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "300");
    assert.equal(((await res.json()) as { code: string }).code, "SERVICE_TEMPORARILY_UNAVAILABLE");
  });

  /**
   * A 402 is an invitation to pay. Issued for a handler that does not exist, it invites a caller to
   * buy work this deployment cannot perform — so the refusal must come first.
   */
  test("an unported PAID route never emits a payment challenge", async () => {
    const res = await dispatch(routerFor(), new Request(`${BASE}/verify_delivery`, { method: "POST" }), {
      onNotFound: stage1Fallback,
    });
    assert.notEqual(res.status, 402);
    assert.equal(res.headers.get("payment-required"), null);
    assert.equal(res.headers.get("www-authenticate"), null);
  });

  test("an unported route reached by the wrong method answers 405 and names the methods it takes", async () => {
    // A path the manifest serves under exactly one method, and not one Stage 1 answers.
    const single = manifest.routes.find((r) => {
      if (servedPairs.has(`${r.method} ${r.path}`) || r.path.includes(":")) return false;
      return manifest.routes.filter((o) => o.path === r.path).length === 1 && r.method !== "GET";
    });
    assert.ok(single, "the manifest must contain a single-method unported route for this check");

    const res = await dispatch(routerFor(), new Request(`${BASE}${single.path}`, { method: "GET" }), {
      onNotFound: stage1Fallback,
    });
    assert.equal(res.status, 405, `GET ${single.path}`);
    assert.equal(res.headers.get("allow"), single.method);
  });

  test("a path Express never served answers 404, in the envelope Express uses", async () => {
    const res = await workerGet("/definitely-not-a-route");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, "ROUTE_NOT_FOUND");
    assert.match(body.message, /GET \/catalog lists every tool this service serves/);
  });

  /**
   * THE PROPERTY THAT KEEPS A PARTIAL CUTOVER FROM READING AS A WITHDRAWAL.
   *
   * Every one of the 126 routes Express serves must resolve to something that says "real endpoint" —
   * served, or 503, or 405. Not one may 404.
   */
  test("no route Express serves ever answers 404 on the Worker", async () => {
    const unserved = manifest.routes.filter((r) => !servedPairs.has(`${r.method} ${r.path}`));
    assert.ok(unserved.length > 0, "the manifest must still contain unported routes at Stage 1");

    for (const route of unserved) {
      const probe = route.path.split("/").map((s) => (s.startsWith(":") ? "probe" : s)).join("/");
      const res = await dispatch(routerFor(), new Request(`${BASE}${probe}`, { method: route.method }), {
        onNotFound: stage1Fallback,
      });
      assert.equal(
        res.status,
        503,
        `${route.method} ${route.path} answered ${res.status}. A 404 on a route Express serves reads as ` +
          "a withdrawn service to a marketplace validator.",
      );
    }
  });
});

describe("the deployment annotation tells the truth about posture", () => {
  test("it reports both gates closed when both are closed", async () => {
    const body = (await (await workerGet("/catalog")).json()) as {
      deployment: { financiallyArmed: boolean; productionWriter: string; callablePaths: string[] };
    };
    assert.equal(body.deployment.financiallyArmed, false);
    assert.equal(body.deployment.productionWriter, "elsewhere");
    assert.deepEqual(body.deployment.callablePaths, [...STAGE1_SERVED].sort());
  });

  test("readiness follows schema verification rather than asserting it", async () => {
    const ok = await workerGet("/readyz");
    assert.equal(ok.status, 200);

    const failed = await workerGet(
      "/readyz",
      ctx({ schema: { ok: false, reason: "MISSING_MIGRATIONS", detail: "gap at 020" } as never }),
    );
    assert.equal(failed.status, 503, "a deployment that cannot verify its schema is not ready");
  });
});
