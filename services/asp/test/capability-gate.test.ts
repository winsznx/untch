import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createSellerApp } from "../src/server";
import { consumerPricedRoutes } from "../src/consumer/routes";
import {
  HISTORY_DEPENDENT_PATHS,
  PROVIDER_EXECUTION_UNAVAILABLE,
  REQUIRED_HISTORY_UNAVAILABLE,
  capabilityRefusal,
  pathMatches,
} from "../src/consumer/capability-gate";
import { CAFE_LATTE_ROUTE, PING_ROUTE, PREFLIGHT_ROUTE, VERIFY_ROUTE } from "../src/config";
import type { ConsumerAuthConfig } from "../src/consumer/auth";
import { decodeChallenge, startFacilitatorStub, type FacilitatorStub } from "./fixtures/facilitator-stub";

/**
 * A route that cannot serve the caller must not be allowed to bill them.
 *
 * The suite is built around the REAL app rather than a hand-assembled Express instance, because the
 * guarantee under test is positional: the gate has to sit above `paymentMiddleware`, and a test that
 * mounts only the gate would pass no matter where the gate was mounted in production. Every
 * assertion below therefore goes through `createSellerApp` and reads what an external caller reads.
 *
 * Needs no database. The Consumer Pack is unwired here, which is the honest shape of the check: an
 * unauthenticated stranger must be refused for free whether or not this deployment has a store.
 */

const PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";

const CONFIG = {
  okxApiKey: "test-api-key",
  okxSecretKey: "test-secret-key",
  okxPassphrase: "test-passphrase",
  payTo: PAY_TO as `0x${string}`,
  port: 0,
};

/**
 * One server for the whole file, pointed at a local facilitator stub.
 *
 * The stub answers exactly one call — "which payment kinds do you support" — because without an
 * answer to it `paymentMiddleware` cannot produce a challenge at all and every priced route 500s.
 * Nothing downstream is substituted: the real SDK builds the real 402 from the real route table,
 * which is what the last test here reads.
 */
let server: Server | null = null;
let facilitator: FacilitatorStub | null = null;
let baseUrl = "";

before(async () => {
  facilitator = await startFacilitatorStub();
  process.env.OKX_X402_FACILITATOR_URL = facilitator.url;
  const app = createSellerApp(CONFIG);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bound port");
  // production-surface-allow: localhost — an ephemeral in-test listener, never a published URL.
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  delete process.env.OKX_X402_FACILITATOR_URL;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (facilitator) await facilitator.close();
});

/** Every priced Consumer Pack path, read from the SAME table the payment middleware is built from. */
const PRICED_CONSUMER_PATHS = Object.keys(
  consumerPricedRoutes({ network: "eip155:196", payTo: PAY_TO, fundingPrice: null }),
).map((key) => key.slice(key.indexOf(" ") + 1));

/** `:intentId` is not a URL. Substituted so the probe is a request a real caller could send. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "probe");
}

describe("pathMatches", () => {
  test("matches a literal path exactly", () => {
    assert.equal(pathMatches("/consumer/shop/search", "/consumer/shop/search"), true);
    assert.equal(pathMatches("/consumer/shop/search", "/consumer/shop/searchx"), false);
    assert.equal(pathMatches("/consumer/shop/search", "/consumer/shop"), false);
  });

  test("matches a named segment against any non-empty value", () => {
    assert.equal(pathMatches("/consumer/fund/:intentId", "/consumer/fund/abc"), true);
    assert.equal(pathMatches("/consumer/fund/:intentId", "/consumer/fund/"), false);
    assert.equal(pathMatches("/consumer/fund/:intentId", "/consumer/fund"), false);
  });

  test("does not let a named segment swallow extra path segments", () => {
    assert.equal(pathMatches("/consumer/fund/:intentId", "/consumer/fund/a/b"), false);
  });

  test("ignores a trailing slash and a query string", () => {
    assert.equal(pathMatches("/consumer/shop/search", "/consumer/shop/search/"), true);
    assert.equal(pathMatches("/consumer/shop/search", "/consumer/shop/search?policyId=7"), true);
  });
});

describe("capabilityRefusal", () => {
  const openAuth: ConsumerAuthConfig = { secret: null, domain: "asp.untch.xyz", required: false };
  const deps = {
    pricedConsumerPaths: PRICED_CONSUMER_PATHS,
    executionEnabled: () => true,
    authConfig: () => openAuth,
  };

  test("refuses an unauthenticated Consumer Pack POST", () => {
    const refusal = capabilityRefusal(
      { method: "POST", path: "/consumer/shop/search", authorization: undefined },
      deps,
    );
    assert.equal(refusal?.code, PROVIDER_EXECUTION_UNAVAILABLE);
  });

  /**
   * The exact bypass this gate would otherwise have.
   *
   * `resolveScope` offers an UNPROVEN scope from `?policyId=` while `CONSUMER_AUTH_REQUIRED` is off.
   * That is namespacing, not authorisation, and accepting it here would let a stranger restore the
   * trap by appending a query parameter to the URL.
   */
  test("an unproven query-parameter scope does not open the paywall", () => {
    const refusal = capabilityRefusal(
      { method: "POST", path: "/consumer/shop/search?policyId=7", authorization: undefined },
      deps,
    );
    assert.equal(refusal?.code, PROVIDER_EXECUTION_UNAVAILABLE);
  });

  test("a malformed bearer token is refused, not passed through", () => {
    const refusal = capabilityRefusal(
      { method: "POST", path: "/consumer/shop/search", authorization: "Bearer not-a-real-token" },
      { ...deps, authConfig: () => ({ ...openAuth, secret: "test-secret" }) },
    );
    assert.equal(refusal?.code, PROVIDER_EXECUTION_UNAVAILABLE);
  });

  test("refuses every history-dependent tool regardless of authentication", () => {
    for (const path of HISTORY_DEPENDENT_PATHS) {
      const anonymous = capabilityRefusal({ method: "POST", path, authorization: undefined }, deps);
      assert.equal(anonymous?.code, REQUIRED_HISTORY_UNAVAILABLE, path);
      const authenticated = capabilityRefusal(
        { method: "POST", path, authorization: "Bearer anything" },
        deps,
      );
      assert.equal(authenticated?.code, REQUIRED_HISTORY_UNAVAILABLE, path);
    }
  });

  test("refuses Consumer Pack when provider execution is disabled", () => {
    const refusal = capabilityRefusal(
      { method: "POST", path: "/consumer/shop/search", authorization: undefined },
      { ...deps, executionEnabled: () => false },
    );
    assert.equal(refusal?.code, PROVIDER_EXECUTION_UNAVAILABLE);
  });

  test("does not gate a marketplace route", () => {
    for (const path of [PREFLIGHT_ROUTE, VERIFY_ROUTE, PING_ROUTE, CAFE_LATTE_ROUTE, "/catalog"]) {
      assert.equal(capabilityRefusal({ method: "POST", path, authorization: undefined }, deps), null, path);
    }
  });

  /** GET and HEAD on these paths carry no price, so a refusal here would remove a working read. */
  test("does not gate a non-POST method", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(
        capabilityRefusal({ method, path: "/consumer/shop/search", authorization: undefined }, deps),
        null,
        method,
      );
    }
  });
});

describe("the running server", () => {
  /**
   * The assertion that matters: not merely that the body says 503, but that the response carries no
   * payment challenge. `paymentMiddleware` publishes its challenge in the `PAYMENT-REQUIRED` header,
   * so a 503 with that header set would mean the gate ran too late and the caller was still asked to
   * pay.
   */
  test("no priced Consumer Pack route can return 402 to a stranger", async () => {
    const seen: string[] = [];
    for (const pattern of PRICED_CONSUMER_PATHS) {
      const res = await fetch(`${baseUrl}${concrete(pattern)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.notEqual(res.status, 402, `${pattern} returned a payment challenge`);
      assert.equal(res.status, 503, pattern);
      assert.equal(res.headers.get("payment-required"), null, `${pattern} carried a challenge header`);
      assert.equal(res.headers.get("www-authenticate"), null, `${pattern} carried a challenge header`);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, PROVIDER_EXECUTION_UNAVAILABLE, pattern);
      seen.push(pattern);
    }
    // A silently empty table would make every assertion above vacuous.
    assert.ok(seen.length >= 26, `expected the full Consumer Pack, saw ${seen.length}`);
  });

  test("no history-dependent tool can return 402 to a stranger", async () => {
    for (const path of HISTORY_DEPENDENT_PATHS) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.notEqual(res.status, 402, `${path} returned a payment challenge`);
      assert.equal(res.status, 503, path);
      assert.equal(res.headers.get("payment-required"), null, path);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, REQUIRED_HISTORY_UNAVAILABLE, path);
    }
  });

  /**
   * The other half of the guarantee. A gate that refused everything would also satisfy the tests
   * above, so a marketplace route has to be shown still reaching the paywall and still publishing a
   * challenge that names the right chain, the right token and the right payee.
   */
  test("a marketplace paid route still returns a compliant 402", async () => {
    const res = await fetch(`${baseUrl}${PREFLIGHT_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 402);
    const challenge = decodeChallenge(res.headers.get("payment-required"));
    assert.equal(challenge.x402Version, 2);
    // The challenge binds the EXACT resource that was called, not a configured constant — which is
    // what makes an authorization signed against it unusable on any other route.
    assert.equal(challenge.resource.url, `${baseUrl}${PREFLIGHT_ROUTE}`);
    const accepted = challenge.accepts[0]!;
    assert.equal(accepted.scheme, "exact");
    assert.equal(accepted.network, "eip155:196");
    assert.equal(accepted.asset, "0x779ded0c9e1022225f8e0630b35a9b54be713736");
    assert.equal(accepted.payTo, PAY_TO);
    assert.equal(accepted.amount, "50000");
  });
});
