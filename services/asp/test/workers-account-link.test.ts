import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCOUNT_LINK_COMPLETE_ROUTE,
  ACCOUNT_LINK_START_ROUTE,
  handleLinkComplete,
} from "../src/consumer/account-link";
import { accountLinkRoutes } from "../src/workers/account-link-routes";

/**
 * The head of the account chain, on Workers.
 *
 * The Worker shipped the account reads and the policy routes without these two, so every
 * account-scoped route answered 401 to a caller who had no way to stop being anonymous. The handler
 * logic itself is the one Express serves and is covered by `account-routes-pg.test.ts`; what is worth
 * pinning here is that the Worker registers them, refuses to write when it does not own writes, and
 * cannot consume a user's signature on a deployment that could never issue them a session.
 */

const deps = (over: Partial<Parameters<typeof accountLinkRoutes>[0]> = {}) =>
  accountLinkRoutes({
    pool: {} as never,
    secret: "s".repeat(32),
    baseUrl: "https://asp.untch.xyz",
    rpcUrl: "https://rpc.xlayer.tech",
    gate: { ownsWrites: true, reason: null } as never,
    ...over,
  });

describe("the Worker can mint a session at all", () => {
  test("both link routes are served, so the chain has a head", () => {
    const patterns = deps().map((r) => `${r.method} ${r.pattern}`);
    assert.deepEqual(patterns, [
      `POST ${ACCOUNT_LINK_START_ROUTE}`,
      `POST ${ACCOUNT_LINK_COMPLETE_ROUTE}`,
    ]);
  });

  test("neither is priced — signing in is not a purchase", () => {
    for (const r of deps()) {
      assert.ok(!r.priced, `${r.pattern} must not reach the payment gate`);
    }
  });

  /**
   * A deployment that does not own production writes must not hand out a one-time code: it would be
   * recording a PENDING row it could never redeem, and the user would sign for nothing.
   */
  test("a deployment without write ownership refuses rather than issuing a dead code", async () => {
    const routes = deps({ gate: { ownsWrites: false, reason: "preview" } as never });
    for (const r of routes) {
      await assert.rejects(
        () => Promise.resolve(r.handler({ body: {}, request: new Request("https://x/y", { method: "POST" }), params: {} } as never)),
        "a preview must not record link state",
      );
    }
  });
});

describe("a link cannot be consumed by a deployment that cannot complete it", () => {
  /**
   * On Express this was implicit: `registerAccountRoutes` answers 503 for every account route when the
   * secret is absent, so the handler could never run without one. Extracting the body moved it out of
   * that guarantee, and completing a link only to find at the last line that no token can be minted
   * would burn the user's one-time code AND their signature for nothing.
   */
  test("no session secret means refused up front, with the code left unused", async () => {
    const result = await handleLinkComplete(
      { linkRequestId: "lr_1", code: "c", message: "m", signature: "0x1" },
      {
        accounts: {
          async getDraft() { throw new Error("must not be reached"); },
        } as never,
        links: {
          async get() { throw new Error("the link request must not even be read"); },
        } as never,
        verifier: { async verify() { throw new Error("must not verify"); } },
        domain: "asp.untch.xyz",
        publicBaseUrl: "https://asp.untch.xyz",
        allowedReturnOrigins: [],
        secret: null,
        now: () => 1,
      },
    );
    assert.equal(result.status, 503);
    assert.equal((result.body as { code: string }).code, "ACCOUNT_LINK_UNAVAILABLE");
    assert.match((result.body as { message: string }).message, /unused/);
  });
});

describe("the return-origin allow-list", () => {
  const start = (returnUrl: string) =>
    deps()[0]!.handler({
      body: { returnUrl },
      request: new Request("https://asp.untch.xyz/consumer/account/link/start", { method: "POST" }),
      params: {},
    } as never) as Promise<Response>;

  /**
   * A returnUrl is where a browser is sent holding a fresh session. The Railway host sat on Express's
   * default list and that domain has since been released, so it is an open redirect waiting for
   * whoever registers it next. Asserted through the route rather than by reading the source, because
   * a list can be correct in the file and still not be the one the handler consults.
   */
  test("a released domain is refused", async () => {
    const res = await start("https://untch-web-production.up.railway.app/done");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "RETURN_URL_NOT_ALLOWED");
  });

  test("an unrelated origin is refused too, so the list is doing work", async () => {
    const res = await start("https://evil.example/steal");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "RETURN_URL_NOT_ALLOWED");
  });
});
