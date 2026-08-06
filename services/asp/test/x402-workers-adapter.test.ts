import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  WorkersHTTPAdapter,
  workersPaymentGateFromHTTPServer,
  type PaidHandler,
} from "../src/workers/x402-adapter";

/**
 * The Workers payment adapter, against a stubbed core.
 *
 * WHAT IS STUBBED AND WHY
 *
 * `x402HTTPResourceServer` is stubbed, not the payment logic — because the whole point of this file
 * is that the adapter contains NO payment logic to test. What must be proven is that the adapter
 * hands the core the right context and honours the core's answer, including the two behaviours that
 * cost real money when they regress:
 *
 *   • a handler that fails must not settle
 *   • the response must be buffered before settlement, never streamed past it
 *
 * A test against the real facilitator would prove neither, because both are decisions this file makes
 * before and after the SDK is consulted.
 */

interface StubCall {
  readonly kind: string;
  readonly detail?: unknown;
}

function stubServer(behaviour: {
  requiresPayment?: boolean;
  process?: unknown;
  settle?: unknown;
  settleThrows?: Error;
}) {
  const calls: StubCall[] = [];
  const server = {
    requiresPayment(ctx: { path: string; method: string; paymentHeader?: string }) {
      calls.push({ kind: "requiresPayment", detail: { path: ctx.path, method: ctx.method, paymentHeader: ctx.paymentHeader } });
      return behaviour.requiresPayment ?? true;
    },
    async initialize() {
      calls.push({ kind: "initialize" });
    },
    registerPaywallProvider() {},
    async processHTTPRequest() {
      calls.push({ kind: "processHTTPRequest" });
      return behaviour.process ?? { type: "no-payment-required" };
    },
    async processSettlement(_p: unknown, _r: unknown, _e: unknown, transport: { responseBody?: Uint8Array; responseHeaders?: Record<string, string> }) {
      calls.push({
        kind: "processSettlement",
        detail: {
          body: transport.responseBody ? new TextDecoder().decode(transport.responseBody) : null,
          headers: transport.responseHeaders,
        },
      });
      if (behaviour.settleThrows) throw behaviour.settleThrows;
      return behaviour.settle ?? { success: true, headers: { "x-payment-response": "settled" } };
    },
  };
  return { server, calls };
}

describe("the Workers HTTP adapter presents the request the core expects", () => {
  test("every accessor reads from the Web Request, and the URL keeps its scheme and host", () => {
    const req = new Request("https://asp.untch.xyz/preflight_payment?a=1&a=2&b=x", {
      method: "POST",
      headers: {
        accept: "application/json",
        "user-agent": "untch-test/1.0",
        "payment-signature": "sig-abc",
      },
    });
    const adapter = new WorkersHTTPAdapter(req, { intentId: "ci_1" });

    assert.equal(adapter.getMethod(), "POST");
    assert.equal(adapter.getPath(), "/preflight_payment");
    assert.equal(adapter.getUrl(), "https://asp.untch.xyz/preflight_payment?a=1&a=2&b=x");
    assert.equal(adapter.getAcceptHeader(), "application/json");
    assert.equal(adapter.getUserAgent(), "untch-test/1.0");
    assert.equal(adapter.getHeader("payment-signature"), "sig-abc");
    assert.equal(adapter.getHeader("nope"), undefined);
    assert.deepEqual(adapter.getQueryParam("a"), ["1", "2"]);
    assert.equal(adapter.getQueryParam("b"), "x");
    assert.equal(adapter.getQueryParam("missing"), undefined);
    assert.deepEqual(adapter.getQueryParams(), { a: ["1", "2"], b: "x" });
    assert.deepEqual(adapter.getBody(), { intentId: "ci_1" });
  });

  test("the URL stays https, so `resource` in the 402 matches the listed endpoint", () => {
    const adapter = new WorkersHTTPAdapter(new Request("https://asp.untch.xyz/verify_delivery"), null);
    assert.match(adapter.getUrl(), /^https:\/\/asp\.untch\.xyz\//);
  });

  /**
   * The adapter must never touch the request stream. A `Request` body can be read once, and the route
   * handler downstream needs it — so the boundary reads it and passes the value in.
   */
  test("the adapter does not consume the request body stream", async () => {
    const req = new Request("https://asp.untch.xyz/preflight_payment", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });
    const adapter = new WorkersHTTPAdapter(req, { hello: "world" });
    adapter.getBody();
    adapter.getQueryParams();
    assert.equal(req.bodyUsed, false, "the adapter must leave the stream unread for the handler");
    assert.deepEqual(await req.json(), { hello: "world" });
  });
});

describe("the gate honours the core's verdict and nothing else", () => {
  const handlerOk: PaidHandler = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

  test("an unpriced route runs the handler without consulting payment at all", async () => {
    const { server, calls } = stubServer({ requiresPayment: false });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(new Request("https://asp.untch.xyz/ping_untch"), null, handlerOk);

    assert.equal(res.status, 200);
    assert.ok(!calls.some((c) => c.kind === "processHTTPRequest"), "no payment processing for a free route");
    assert.ok(!calls.some((c) => c.kind === "processSettlement"), "nothing settles on a free route");
  });

  test("the core's payment-error instruction is returned verbatim, including its 402 body", async () => {
    const { server } = stubServer({
      requiresPayment: true,
      process: {
        type: "payment-error",
        response: {
          status: 402,
          headers: { "x-untch": "from-core" },
          body: { x402Version: 1, accepts: [{ scheme: "exact", network: "eip155:196" }] },
        },
      },
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(new Request("https://asp.untch.xyz/preflight_payment"), null, handlerOk);

    assert.equal(res.status, 402);
    assert.equal(res.headers.get("x-untch"), "from-core");
    const body = (await res.json()) as { accepts: { network: string }[] };
    assert.equal(body.accepts[0]!.network, "eip155:196", "the 402 schema comes from the SDK untouched");
  });

  test("an HTML paywall instruction is rendered as HTML rather than JSON", async () => {
    const { server } = stubServer({
      requiresPayment: true,
      process: { type: "payment-error", response: { status: 402, headers: {}, body: "<html>pay</html>", isHtml: true } },
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(new Request("https://asp.untch.xyz/preflight_payment"), null, handlerOk);

    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await res.text(), "<html>pay</html>");
  });
});

describe("a failing handler is never charged for", () => {
  /**
   * THE PROPERTY THAT COSTS MONEY WHEN IT REGRESSES.
   *
   * `paymentMiddleware` settles on the way out of any 2xx and skips settlement entirely on >= 400.
   * Losing that guard bills a caller for a refusal — and the ASP refuses constantly and by design:
   * the capability gate, the validation layer and every authority check answer 4xx.
   */
  for (const status of [400, 401, 402, 403, 409, 422, 500, 503]) {
    test(`a handler ${status} settles nothing and is returned unchanged`, async () => {
      const { server, calls } = stubServer({
        requiresPayment: true,
        process: { type: "payment-verified", paymentPayload: { p: 1 }, paymentRequirements: { r: 1 } },
      });
      const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
      const res = await gate(
        new Request("https://asp.untch.xyz/preflight_payment"),
        null,
        () => new Response(JSON.stringify({ code: "REFUSED" }), { status, headers: { "content-type": "application/json" } }),
      );

      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), { code: "REFUSED" });
      assert.ok(
        !calls.some((c) => c.kind === "processSettlement"),
        `a ${status} must not reach processSettlement — that would charge for a refusal`,
      );
    });
  }

  test("a 2xx does settle, so the guard is not simply refusing everything", async () => {
    const { server, calls } = stubServer({
      requiresPayment: true,
      process: { type: "payment-verified", paymentPayload: { p: 1 }, paymentRequirements: { r: 1 } },
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(
      new Request("https://asp.untch.xyz/preflight_payment"),
      null,
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-payment-response"), "settled");
    assert.ok(calls.some((c) => c.kind === "processSettlement"), "a successful paid call must settle");
  });
});

describe("the response is buffered before settlement, not streamed past it", () => {
  test("processSettlement receives the exact handler body", async () => {
    const { server, calls } = stubServer({
      requiresPayment: true,
      process: { type: "payment-verified", paymentPayload: {}, paymentRequirements: {} },
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const payload = JSON.stringify({ intentHash: "0xabc", proofTier: 0 });
    await gate(new Request("https://asp.untch.xyz/preflight_payment"), null, () => new Response(payload, { status: 200 }));

    const settle = calls.find((c) => c.kind === "processSettlement");
    assert.ok(settle, "settlement ran");
    assert.equal((settle.detail as { body: string }).body, payload, "the settled body is the handler's exact bytes");
  });

  test("the settlement-overrides header is forwarded to the core and stripped from the response", async () => {
    const { server, calls } = stubServer({
      requiresPayment: true,
      process: { type: "payment-verified", paymentPayload: {}, paymentRequirements: {} },
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(
      new Request("https://asp.untch.xyz/preflight_payment"),
      null,
      () => new Response("{}", { status: 200, headers: { "settlement-overrides": '{"amount":"50000"}' } }),
    );

    const settle = calls.find((c) => c.kind === "processSettlement");
    assert.deepEqual(
      (settle!.detail as { headers: Record<string, string> }).headers,
      { "settlement-overrides": '{"amount":"50000"}' },
      "the override must reach the core",
    );
    assert.equal(res.headers.get("settlement-overrides"), null, "and must not leak to the caller");
  });

  test("a settlement failure replaces the body rather than serving unpaid work", async () => {
    const { server } = stubServer({
      requiresPayment: true,
      process: { type: "payment-verified", paymentPayload: {}, paymentRequirements: {} },
      settle: {
        success: false,
        headers: { "x-settle": "no" },
        response: { status: 402, headers: {}, body: { error: "settlement failed" } },
      },
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(
      new Request("https://asp.untch.xyz/preflight_payment"),
      null,
      () => new Response(JSON.stringify({ secret: "the paid result" }), { status: 200 }),
    );

    assert.equal(res.status, 402);
    const body = await res.text();
    assert.ok(!body.includes("the paid result"), "unsettled work must never be delivered");
  });

  test("an unexpected settlement error answers a bare 402 and leaks no result", async () => {
    const { server } = stubServer({
      requiresPayment: true,
      process: { type: "payment-verified", paymentPayload: {}, paymentRequirements: {} },
      settleThrows: new Error("facilitator exploded"),
    });
    const gate = workersPaymentGateFromHTTPServer(server as never, { syncFacilitatorOnStart: false });
    const res = await gate(
      new Request("https://asp.untch.xyz/preflight_payment"),
      null,
      () => new Response(JSON.stringify({ secret: "the paid result" }), { status: 200 }),
    );

    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), {});
  });
});
