import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TLDS, checkDomainsLive } from "../src/launch-pack/rdap";

/**
 * A domain check must never claim a registered name is free.
 *
 * Two real false-AVAILABLE results are locked down here, both found by running the live service
 * against domains whose status is not in doubt:
 *
 *   • `untch.xyz` — this project's own domain, in continuous use — was reported AVAILABLE, because
 *     CentralNic's `.xyz` endpoint answers 400 to every query and the code read 400 as "not
 *     registered".
 *   • `google.io` was reported AVAILABLE, because the `.io` registry publishes no usable RDAP and
 *     returns 404 for registered and unregistered names alike.
 *
 * The second is the subtler one: nothing in a 404 says whether the TLD is served at all, so the only
 * correct answer for an unserved TLD is that this service does not know.
 *
 * `fetch` is stubbed so the assertions are about the decision rule rather than about whichever
 * registry happens to be reachable from CI.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondWith(status: number, body: unknown = {}): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/rdap+json" },
    })) as typeof fetch;
}

describe("rdap availability", () => {
  test("a 404 on a trusted TLD is AVAILABLE", async () => {
    respondWith(404);
    const [result] = await checkDomainsLive(["definitely-free-99.com"]);
    assert.equal(result?.status, "AVAILABLE");
    assert.equal(result?.available, true);
  });

  test("a 200 on a trusted TLD is TAKEN", async () => {
    respondWith(200, { objectClassName: "domain", handle: "X" });
    const [result] = await checkDomainsLive(["untch.xyz"]);
    assert.equal(result?.status, "TAKEN");
    assert.equal(result?.available, false);
  });

  /** The `untch.xyz` regression. A 400 is not an answer and must never read as one. */
  test("a 400 is UNKNOWN, never AVAILABLE", async () => {
    respondWith(400);
    const [result] = await checkDomainsLive(["untch.xyz"]);
    assert.equal(result?.status, "UNKNOWN");
    assert.equal(result?.available, null);
  });

  test("a 422 is UNKNOWN, never AVAILABLE", async () => {
    respondWith(422);
    const [result] = await checkDomainsLive(["untch.xyz"]);
    assert.equal(result?.status, "UNKNOWN");
  });

  test("a 200 carrying an RDAP not-found error is AVAILABLE", async () => {
    respondWith(200, { errorCode: 404, title: "Not Found" });
    const [result] = await checkDomainsLive(["definitely-free-99.com"]);
    assert.equal(result?.status, "AVAILABLE");
  });

  /**
   * The `google.io` regression. No request should even be made: the answer would be unreadable, and
   * asserting on the call count is what proves the gate runs before the lookup rather than after it.
   */
  test("an untrusted TLD is UNKNOWN without a lookup", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const [result] = await checkDomainsLive(["google.io"]);
    assert.equal(result?.status, "UNKNOWN");
    assert.equal(result?.available, null);
    assert.match(result?.detail ?? "", /no trusted RDAP source for \.io/);
    assert.equal(calls, 0);
  });

  test("a network failure is UNKNOWN", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const [result] = await checkDomainsLive(["untch.xyz"]);
    assert.equal(result?.status, "UNKNOWN");
  });

  /** A default the checker cannot answer for would return UNKNOWN for every caller who took it. */
  test("every default TLD is one the checker trusts", async () => {
    respondWith(404);
    const results = await checkDomainsLive(DEFAULT_TLDS.map((tld) => `some-free-name-99${tld}`));
    for (const result of results) {
      assert.equal(result.status, "AVAILABLE", `${result.domain} is a default the checker cannot answer for`);
    }
  });
});
