import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCOUNT_LINK_COMPLETE_ROUTE,
  ACCOUNT_LINK_START_ROUTE,
  handleLinkComplete,
  handleLinkStart,
} from "../src/consumer/account-link";
import { accountLinkRoutes } from "../src/workers/account-link-routes";
import { handleLinkMessage } from "../src/consumer/account-link";

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
  test("the whole browser journey is served, not just the API halves", () => {
    const patterns = deps().map((r) => `${r.method} ${r.pattern}`);
    assert.deepEqual(patterns, [
      `POST ${ACCOUNT_LINK_START_ROUTE}`,
      "POST /consumer/account/link/:linkRequestId/message",
      `POST ${ACCOUNT_LINK_COMPLETE_ROUTE}`,
      "GET /link/:linkRequestId",
      // The PRIMARY wallet path. Shipping only the browser half inverted the design.
      "POST /consumer/account/agentic-link/start",
      "GET /consumer/account/agentic-link/:linkRequestId/challenge",
      "POST /consumer/account/agentic-link/:linkRequestId/complete",
      "GET /consumer/account/agentic-link/:linkRequestId/status",
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
    /**
     * The two that RECORD something. The message endpoint and the page read and render — gating those
     * would refuse to show a user the text of a message on a deployment that simply cannot mint the
     * session, which tells them nothing and helps no one.
     */
    const writing = routes.filter((r) => r.pattern === ACCOUNT_LINK_START_ROUTE || r.pattern === ACCOUNT_LINK_COMPLETE_ROUTE);
    assert.equal(writing.length, 2);
    for (const r of writing) {
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

/**
 * Found by pointing a hand-typed address at the live service and getting an INTERNAL_ERROR back at the
 * LAST step of the flow — after the user would already have signed.
 *
 * Driven through `handleLinkStart` with fake stores rather than through the route, so a refusal is
 * distinguishable from a database that was never reached.
 */
describe("a bad address is refused before anyone signs", () => {
  let created = 0;
  const linkDeps = {
    accounts: {} as never,
    links: {
      async create() {
        created += 1;
        return {
          request: {
            linkRequestId: "ulnk_x",
            siweNonce: "n".repeat(32),
            expiresAt: "2099-01-01T00:00:00.000Z",
            requestedScopes: ["identity"],
            context: {},
            returnUrl: null,
          },
          code: "code",
        };
      },
    } as never,
    verifier: { async verify() { return true; } },
    domain: "asp.untch.xyz",
    publicBaseUrl: "https://asp.untch.xyz",
    allowedReturnOrigins: ["https://asp.untch.xyz"],
    secret: "s".repeat(32),
    now: () => 1_760_000_000_000,
  };

  const start = (address: string) => {
    created = 0;
    return handleLinkStart({ address, chainId: 196 }, linkDeps);
  };

  test("mixed case that fails EIP-55 is refused at start, not at complete", async () => {
    // Correct: 0x57a3660e8D10a89DFaee9C130a73c9BCC76e8950. This one is uppercase-mangled in the middle.
    const r = await start("0x57a3660e8D10a89DfAeE9c130a73c9bcC76e8950");
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, "ADDRESS_INVALID");
    assert.equal(created, 0, "a refused address must not leave a PENDING link request behind");
  });

  /**
   * All-lowercase and all-uppercase carry no checksum, so there is nothing there to be wrong. Refusing
   * them would be a papercut with no safety behind it.
   */
  for (const [label, addr] of [
    ["all-lowercase", "0x57a3660e8d10a89dfaee9c130a73c9bcc76e8950"],
    ["all-uppercase", "0x57A3660E8D10A89DFAEE9C130A73C9BCC76E8950"],
  ] as const) {
    test(`an ${label} address is accepted and normalised into the message`, async () => {
      const r = await start(addr);
      assert.equal(r.status, 200);
      const msg = (r.body as { siweMessage: string }).siweMessage;
      assert.ok(
        msg.includes("0x57a3660e8D10a89DFaee9C130a73c9BCC76e8950"),
        "the message must carry the checksummed form, which is what viem will parse at complete",
      );
    });
  }

  test("a non-address is refused", async () => {
    const r = await start("not-an-address");
    assert.equal(r.status, 400);
    assert.equal((r.body as { code: string }).code, "ADDRESS_INVALID");
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

/**
 * THE BUG A RANDOM USER WOULD HAVE HIT FIRST.
 *
 * `link/start` has always answered with `walletActionUrl: {base}/link/{id}` and instructions whose
 * first step is "Open that URL with the wallet you want this account to be." Nothing served it — not
 * the Worker, not Express, and there is no such page in apps/web. So step one of account setup was a
 * 404, and everything behind it (policy registration, default policy, preflight against your own
 * rules) was unreachable to anyone not driving the raw API by hand.
 *
 * These assert the property that was actually missing: whatever the service ADVERTISES, it serves.
 */
describe("the page link/start tells everyone to open", () => {
  const started = async () => {
    const r = await handleLinkStart({ address: "0x57a3660e8d10a89dfaee9c130a73c9bcc76e8950" }, linkDeps);
    return r.body as { walletActionUrl: string; instructions: string[]; oneTimeCode: string };
  };

  const linkDeps = {
    accounts: {} as never,
    links: {
      async create() {
        return {
          request: {
            linkRequestId: "ulnk_abc",
            siweNonce: "n".repeat(32),
            expiresAt: "2099-01-01T00:00:00.000Z",
            requestedScopes: ["identity"],
            context: {},
            returnUrl: null,
          },
          code: "s3cr3t",
        };
      },
      async get() {
        return {
          linkRequestId: "ulnk_abc",
          status: "PENDING",
          siweNonce: "n".repeat(32),
          expiresAt: "2099-01-01T00:00:00.000Z",
          requestedScopes: ["identity"],
          context: {},
          returnUrl: null,
        };
      },
    } as never,
    verifier: { async verify() { return true; } },
    domain: "asp.untch.xyz",
    publicBaseUrl: "https://asp.untch.xyz",
    allowedReturnOrigins: ["https://asp.untch.xyz"],
    secret: "s".repeat(32),
    now: () => 1_760_000_000_000,
  };

  test("the advertised walletActionUrl matches a route this host serves", async () => {
    const { walletActionUrl } = await started();
    const path = new URL(walletActionUrl).pathname;
    const served = deps().find(
      (r) => r.method === "GET" && /^\/link\/:[A-Za-z]+$/.test(r.pattern),
    );
    assert.ok(served, "nothing serves /link/:id, so the URL we hand every user is a 404");
    assert.match(path, /^\/link\/ulnk_abc$/);
  });

  /**
   * The code is returned once and stored hashed, so the page cannot look it up. In the fragment it
   * reaches the page's JavaScript and never our access logs or `Referer`.
   */
  test("the one-time code travels in the fragment, never the path or query", async () => {
    const { walletActionUrl, oneTimeCode } = await started();
    const url = new URL(walletActionUrl);
    assert.equal(url.hash, `#${oneTimeCode}`, "the page cannot complete a link without the code");
    assert.ok(!url.pathname.includes(oneTimeCode), "a single-use credential must not enter access logs");
    assert.ok(!url.search.includes(oneTimeCode), "nor the query string");
  });

  test("every URL the instructions name is one the host serves", async () => {
    const { instructions } = await started();
    const urls = instructions.flatMap((line) => line.match(/https:\/\/[^\s]+/g) ?? []);
    assert.ok(urls.length > 0, "the instructions should name the page");
    for (const u of urls) {
      assert.match(new URL(u).pathname, /^\/link\/ulnk_abc$/, `${u} is advertised but not served`);
    }
  });

  test("the page is self-contained — a signing page must load no third-party code", async () => {
    const route = deps().find((r) => r.method === "GET" && r.pattern.startsWith("/link/"))!;
    const html = await (await Promise.resolve(
      route.handler({ params: { linkRequestId: "ulnk_abc" }, request: new Request("https://asp.untch.xyz/link/ulnk_abc"), body: undefined } as never),
    ) as Response).text();
    assert.ok(!/src\s*=\s*["']https?:/i.test(html), "no external script may run on a page that signs");
    assert.ok(!/<link[^>]+href\s*=\s*["']https?:/i.test(html), "no external stylesheet either");
  });
});

describe("the message a connecting wallet is asked to sign", () => {
  const base = {
    accounts: {} as never,
    verifier: { async verify() { return true; } },
    domain: "asp.untch.xyz",
    publicBaseUrl: "https://asp.untch.xyz",
    allowedReturnOrigins: [],
    secret: "s".repeat(32),
    now: () => 1_760_000_000_000,
  };
  const withRequest = (over: Record<string, unknown> = {}) => ({
    ...base,
    links: {
      async get() {
        return {
          linkRequestId: "ulnk_abc",
          status: "PENDING",
          siweNonce: "n".repeat(32),
          expiresAt: "2099-01-01T00:00:00.000Z",
          requestedScopes: ["identity"],
          ...over,
        };
      },
    } as never,
  });

  /**
   * The server authors it because `buildLinkMessage` composes the exact wording and stamps it will
   * later verify. A browser copy is a second implementation, and drift shows up as an unexplained
   * signature rejection rather than as the drift it is.
   */
  test("it carries the stored nonce, so the signature verifies against this request", async () => {
    const r = await handleLinkMessage("ulnk_abc", { address: "0x57a3660e8d10a89dfaee9c130a73c9bcc76e8950" }, withRequest() as never);
    assert.equal(r.status, 200);
    const msg = (r.body as { siweMessage: string }).siweMessage;
    assert.match(msg, /Nonce: n{32}/);
    assert.match(msg, /asp\.untch\.xyz wants you to sign in/);
    assert.match(msg, /does not approve any payment/i);
  });

  test("a spent request cannot be re-presented as live", async () => {
    const r = await handleLinkMessage("ulnk_abc", { address: "0x57a3660e8d10a89dfaee9c130a73c9bcc76e8950" }, withRequest({ status: "COMPLETED" }) as never);
    assert.equal(r.status, 409);
  });

  test("an expired request is refused rather than signed against", async () => {
    const r = await handleLinkMessage("ulnk_abc", { address: "0x57a3660e8d10a89dfaee9c130a73c9bcc76e8950" }, withRequest({ expiresAt: "2020-01-01T00:00:00.000Z" }) as never);
    assert.equal(r.status, 410);
  });

  test("an unknown request is a 404, not an empty message", async () => {
    const r = await handleLinkMessage("nope", { address: "0x57a3660e8d10a89dfaee9c130a73c9bcc76e8950" }, {
      ...base, links: { async get() { return null; } } as never,
    } as never);
    assert.equal(r.status, 404);
  });
});

/**
 * The wallet Untch is actually for.
 *
 * The port shipped `/consumer/account/link/*` — which assumes an injected EIP-1193 provider, and so
 * reaches the OKX browser EXTENSION, a different wallet product with different keys — and left the
 * Agentic Wallet routes refusing. That inverted the design: the fallback was the only path served,
 * and the TEE-held wallet a user restores with email, Google or Apple login could not be linked here
 * at all.
 */
describe("the Agentic Wallet path is served, and the page says which is which", () => {
  test("all four agentic routes exist", () => {
    const patterns = deps().map((r) => `${r.method} ${r.pattern}`);
    for (const p of [
      "POST /consumer/account/agentic-link/start",
      "GET /consumer/account/agentic-link/:linkRequestId/challenge",
      "POST /consumer/account/agentic-link/:linkRequestId/complete",
      "GET /consumer/account/agentic-link/:linkRequestId/status",
    ]) {
      assert.ok(patterns.includes(p), `${p} must be served — it is the primary wallet path`);
    }
  });

  /**
   * The two are not interchangeable, and a user who picks the wrong one binds a wallet that holds
   * none of their funds. The page has to say so before it offers a button.
   */
  test("the page names the Onchain OS wallet before offering the extension", async () => {
    const route = deps().find((r) => r.method === "GET" && r.pattern.startsWith("/link/"))!;
    const html = await (await Promise.resolve(
      route.handler({ params: { linkRequestId: "ulnk_abc" }, request: new Request("https://asp.untch.xyz/link/ulnk_abc"), body: undefined } as never),
    ) as Response).text();

    const onchainOs = html.indexOf("Onchain OS wallet");
    const button = html.indexOf("<button");
    assert.ok(onchainOs > -1, "the page must name the wallet most users actually hold");
    assert.ok(onchainOs < button, "it must say so BEFORE the extension button, not after");
    assert.match(html, /agentic-link\/start/, "and it must show how that wallet is linked");
    assert.match(html, /different wallet with different keys/i, "and say plainly that they differ");
  });
});
