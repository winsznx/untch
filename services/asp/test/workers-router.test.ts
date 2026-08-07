import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  RawBodyOrderError,
  WorkersRouter,
  assertRawBodyRoutesFirst,
  dispatch,
  type Route,
} from "../src/workers/router";

/**
 * The Workers router, and specifically the property that a comment cannot enforce: no parsing route
 * may consume the bytes a signature covers.
 */

const ok = (body = "{}"): Response => new Response(body, { status: 200 });
const route = (over: Partial<Route> & Pick<Route, "method" | "pattern" | "bodyMode">): Route => ({
  handler: () => ok(),
  ...over,
});

const req = (method: string, path: string, init: RequestInit = {}): Request =>
  new Request(`https://asp.untch.xyz${path}`, { method, ...init });

describe("matching happens before any body is read", () => {
  test("a path parameter is captured and decoded", async () => {
    const seen: Record<string, string>[] = [];
    const r = new WorkersRouter().add(
      route({
        method: "POST",
        pattern: "/consumer/approvals/:approvalRequestId/act",
        bodyMode: "json",
        handler: (x) => {
          seen.push(x.params);
          return ok();
        },
      }),
    );
    const res = await dispatch(r, req("POST", "/consumer/approvals/aprq_abc%20123/act", { body: "{}" }));
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0], { approvalRequestId: "aprq_abc 123" });
  });

  test("a parameter never spans a slash, so an id cannot traverse into another route", async () => {
    const r = new WorkersRouter().add(route({ method: "GET", pattern: "/consumer/intent/:intentId", bodyMode: "none" }));
    assert.ok(r.match("GET", new URL("https://x/consumer/intent/ci_1")));
    assert.equal(r.match("GET", new URL("https://x/consumer/intent/ci_1/payment")), null);
  });

  /**
   * The literal route must win. `/consumer/approvals/action/discord/interactions` is the raw-body
   * Discord endpoint, and a parameterised sibling must never claim it.
   */
  test("a literal route beats a parameterised one regardless of declaration order", () => {
    const r = new WorkersRouter()
      .add(route({ method: "POST", pattern: "/consumer/approvals/action/:actionReferenceId/confirm", bodyMode: "form" }))
      .add(route({ method: "POST", pattern: "/consumer/approvals/action/discord/interactions", bodyMode: "raw" }));

    const m = r.match("POST", new URL("https://x/consumer/approvals/action/discord/interactions"));
    assert.equal(m?.route.pattern, "/consumer/approvals/action/discord/interactions");
    assert.equal(m?.route.bodyMode, "raw");
  });

  test("method is part of the match", () => {
    const r = new WorkersRouter().add(route({ method: "POST", pattern: "/catalog", bodyMode: "none" }));
    assert.ok(r.match("POST", new URL("https://x/catalog")));
    assert.equal(r.match("GET", new URL("https://x/catalog")), null);
  });

  test("an unmatched path answers a JSON 404, not an HTML one", async () => {
    const r = new WorkersRouter().add(route({ method: "GET", pattern: "/catalog", bodyMode: "none" }));
    const res = await dispatch(r, req("GET", "/nope"));
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(((await res.json()) as { code: string }).code, "ROUTE_NOT_FOUND");
  });
});

describe("the body is shaped by the matched route, and only then", () => {
  test("a raw route receives the exact bytes, unparsed", async () => {
    const wire = '{"type": 3,  "data": {"custom_id": "v1:APPROVE:aref_x"}}';
    let received: Uint8Array | null = null;
    const r = new WorkersRouter().add(
      route({
        method: "POST",
        pattern: "/consumer/approvals/action/discord/interactions",
        bodyMode: "raw",
        handler: (x) => {
          received = x.body as Uint8Array;
          return ok();
        },
      }),
    );
    await dispatch(r, req("POST", "/consumer/approvals/action/discord/interactions", { body: wire }));

    assert.ok(received, "the handler received a body");
    assert.equal(new TextDecoder().decode(received!), wire, "byte-for-byte, including the whitespace");
  });

  test("a json route receives a parsed value", async () => {
    let received: unknown;
    const r = new WorkersRouter().add(
      route({
        method: "POST",
        pattern: "/consumer/auth/verify",
        bodyMode: "json",
        handler: (x) => {
          received = x.body;
          return ok();
        },
      }),
    );
    await dispatch(r, req("POST", "/consumer/auth/verify", { body: JSON.stringify({ message: "m" }) }));
    assert.deepEqual(received, { message: "m" });
  });

  test("malformed JSON is refused by name rather than throwing", async () => {
    const r = new WorkersRouter().add(route({ method: "POST", pattern: "/x", bodyMode: "json" }));
    const res = await dispatch(r, req("POST", "/x", { body: "{not json" }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "INVALID_JSON");
  });

  test("a form route receives decoded entries", async () => {
    let received: unknown;
    const r = new WorkersRouter().add(
      route({
        method: "POST",
        pattern: "/consumer/approvals/action/:actionReferenceId/confirm",
        bodyMode: "form",
        handler: (x) => {
          received = x.body;
          return ok();
        },
      }),
    );
    await dispatch(r, req("POST", "/consumer/approvals/action/aref_1/confirm", { body: "action=APPROVE&csrf=t" }));
    assert.deepEqual(received, { action: "APPROVE", csrf: "t" });
  });

  test("a none route never touches the stream", async () => {
    let raw: Uint8Array | null | undefined;
    const r = new WorkersRouter().add(
      route({
        method: "GET",
        pattern: "/healthz",
        bodyMode: "none",
        handler: (x) => {
          raw = x.rawBody;
          return ok();
        },
      }),
    );
    await dispatch(r, req("GET", "/healthz"));
    assert.equal(raw, null);
  });

  test("an oversized body is refused before a handler sees it", async () => {
    let ran = false;
    const r = new WorkersRouter().add(
      route({
        method: "POST",
        pattern: "/x",
        bodyMode: "json",
        handler: () => {
          ran = true;
          return ok();
        },
      }),
    );
    const res = await dispatch(r, req("POST", "/x", { body: "x".repeat(5000) }), { maxBodyBytes: 1000 });
    assert.equal(res.status, 413);
    assert.equal(ran, false);
  });
});

describe("no parsing route may shadow a raw-body route", () => {
  /**
   * THE REGRESSION GUARD.
   *
   * On Express this bug was a JSON parser mounted above the interactions route. Here it would be a
   * parsing route whose pattern also matches the raw path — the stream gets spent, and every Discord
   * signature fails forever with nothing explaining why. This makes that a build-time error.
   */
  test("a parameterised json route that can claim the Discord path is rejected", () => {
    const r = new WorkersRouter()
      .add(route({ method: "POST", pattern: "/consumer/approvals/action/discord/interactions", bodyMode: "raw" }))
      .add(route({ method: "POST", pattern: "/consumer/approvals/action/discord/:kind", bodyMode: "json" }));

    assert.throws(() => assertRawBodyRoutesFirst(r), RawBodyOrderError);
  });

  test("a wildcard-ish json route covering the raw path is rejected", () => {
    const r = new WorkersRouter()
      .add(route({ method: "POST", pattern: "/a/b/c", bodyMode: "raw" }))
      .add(route({ method: "POST", pattern: "/a/:x/:y", bodyMode: "json" }));

    assert.throws(() => assertRawBodyRoutesFirst(r), RawBodyOrderError);
  });

  test("a parsing route on a DIFFERENT method is fine, because it can never claim the request", () => {
    const r = new WorkersRouter()
      .add(route({ method: "POST", pattern: "/consumer/approvals/action/discord/interactions", bodyMode: "raw" }))
      .add(route({ method: "GET", pattern: "/consumer/approvals/action/discord/:kind", bodyMode: "json" }));

    assert.doesNotThrow(() => assertRawBodyRoutesFirst(r));
  });

  test("a realistic table passes", () => {
    const r = new WorkersRouter().addAll([
      route({ method: "POST", pattern: "/consumer/approvals/action/discord/interactions", bodyMode: "raw" }),
      route({ method: "GET", pattern: "/consumer/approvals/action/discord/callback", bodyMode: "none" }),
      route({ method: "GET", pattern: "/consumer/approvals/action/:actionReferenceId/start", bodyMode: "none" }),
      route({ method: "POST", pattern: "/consumer/approvals/action/:actionReferenceId/confirm", bodyMode: "form" }),
      route({ method: "POST", pattern: "/consumer/approvals/:approvalRequestId/act", bodyMode: "json" }),
      route({ method: "POST", pattern: "/preflight_payment", bodyMode: "json", priced: true }),
      route({ method: "GET", pattern: "/healthz", bodyMode: "none" }),
    ]);

    assert.doesNotThrow(() => assertRawBodyRoutesFirst(r));
    assert.deepEqual(r.rawBodyPaths(), ["/consumer/approvals/action/discord/interactions"]);
  });

  test("the Discord route still gets raw bytes with the realistic table in place", async () => {
    const wire = '{"type":1}';
    let received = "";
    const r = new WorkersRouter().addAll([
      route({ method: "POST", pattern: "/consumer/approvals/:approvalRequestId/act", bodyMode: "json" }),
      route({
        method: "POST",
        pattern: "/consumer/approvals/action/discord/interactions",
        bodyMode: "raw",
        handler: (x) => {
          received = new TextDecoder().decode(x.body as Uint8Array);
          return ok();
        },
      }),
    ]);
    assertRawBodyRoutesFirst(r);
    await dispatch(r, req("POST", "/consumer/approvals/action/discord/interactions", { body: wire }));
    assert.equal(received, wire);
  });
});

describe("the payment gate wraps only priced routes", () => {
  test("a priced route goes through the gate and an unpriced one does not", async () => {
    const gated: string[] = [];
    const r = new WorkersRouter().addAll([
      route({ method: "POST", pattern: "/preflight_payment", bodyMode: "json", priced: true }),
      route({ method: "GET", pattern: "/ping_untch", bodyMode: "none" }),
    ]);
    const paymentGate = async (request: Request, _body: unknown, run: () => Promise<Response>): Promise<Response> => {
      gated.push(new URL(request.url).pathname);
      return run();
    };

    await dispatch(r, req("POST", "/preflight_payment", { body: "{}" }), { paymentGate });
    await dispatch(r, req("GET", "/ping_untch"), { paymentGate });

    assert.deepEqual(gated, ["/preflight_payment"], "only the priced route is gated");
  });

  test("the gate receives the parsed body, so it can price from the request", async () => {
    let seen: unknown;
    const r = new WorkersRouter().add(route({ method: "POST", pattern: "/preflight_payment", bodyMode: "json", priced: true }));
    await dispatch(r, req("POST", "/preflight_payment", { body: JSON.stringify({ intentId: "ci_9" }) }), {
      paymentGate: async (_req, body, run) => {
        seen = body;
        return run();
      },
    });
    assert.deepEqual(seen, { intentId: "ci_9" });
  });
});
