import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_ALLOWED_PORTS,
  OutboundRefusedError,
  guardedFetch,
  headersForRedirect,
  isBlockedAddress,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  validateTarget,
  type HostResolver,
} from "../src/workers-guard";

/**
 * The outbound guard, exercised against the cases that actually get used.
 *
 * DNS is injected rather than real. That is not a shortcut: the property under test is "given these
 * answers, does the guard refuse", and a real resolver would make the suite depend on what the
 * internet returns today. The Workers-specific part — that resolution uses resolve4/resolve6 rather
 * than the unimplemented `lookup` — is a fact about which function is called, asserted separately.
 */

const resolver = (addresses: string[], cnames: string[] = []): HostResolver =>
  async () => ({ addresses, cnames });

const failing = (message: string): HostResolver => async () => {
  throw new Error(message);
};

const PUBLIC_V4 = ["93.184.216.34"];
const PUBLIC_V6 = ["2606:2800:220:1:248:1893:25c8:1946"];

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "(no refusal)";
  } catch (err) {
    assert.ok(err instanceof OutboundRefusedError, `expected a refusal, got ${String(err)}`);
    return err.reason;
  }
};

describe("public destinations are allowed", () => {
  test("a public IPv4 answer is allowed", async () => {
    const t = await validateTarget("https://provider.example/x", { resolver: resolver(PUBLIC_V4) });
    assert.equal(t.url.hostname, "provider.example");
    assert.deepEqual(t.addresses, PUBLIC_V4);
  });

  test("a public IPv6 answer is allowed", async () => {
    const t = await validateTarget("https://provider.example/x", { resolver: resolver(PUBLIC_V6) });
    assert.deepEqual(t.addresses, PUBLIC_V6);
  });

  test("a public literal address needs no DNS at all", async () => {
    const t = await validateTarget("https://93.184.216.34/x", { resolver: failing("must not be called") });
    assert.deepEqual(t.addresses, ["93.184.216.34"]);
  });
});

describe("private and reserved destinations are refused", () => {
  /**
   * One bad answer is enough. A rebinding attacker only needs the connection to pick that record, so
   * a host that resolves to both a public and a private address is refused rather than raced.
   */
  test("a mixed public and private answer is refused", async () => {
    const r = await refusal(() =>
      validateTarget("https://provider.example/x", { resolver: resolver([...PUBLIC_V4, "10.0.0.5"]) }),
    );
    assert.match(r, /non-public address/);
  });

  const literals: [string, string][] = [
    ["localhost", "https://localhost/x"],
    ["127.0.0.1 loopback", "https://127.0.0.1/x"],
    ["0.0.0.0 this-network", "https://0.0.0.0/x"],
    ["RFC1918 10/8", "https://10.1.2.3/x"],
    ["RFC1918 172.16/12", "https://172.20.1.1/x"],
    ["RFC1918 192.168/16", "https://192.168.1.1/x"],
    ["link-local / cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["CGNAT", "https://100.64.0.1/x"],
    ["multicast", "https://224.0.0.1/x"],
    ["broadcast", "https://255.255.255.255/x"],
    ["documentation TEST-NET-2", "https://198.51.100.7/x"],
    ["documentation TEST-NET-3", "https://203.0.113.7/x"],
    ["benchmarking", "https://198.18.0.1/x"],
    ["IPv6 loopback", "https://[::1]/x"],
    ["IPv6 unspecified", "https://[::]/x"],
    ["IPv6 link-local", "https://[fe80::1]/x"],
    ["IPv6 unique-local", "https://[fd00::1]/x"],
    ["IPv6 multicast", "https://[ff02::1]/x"],
    ["IPv6 documentation", "https://[2001:db8::1]/x"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/x"],
    ["IPv4-mapped RFC1918", "https://[::ffff:10.0.0.1]/x"],
    ["6to4 wrapping RFC1918", "https://[2002:0a00:0001::1]/x"],
  ];

  for (const [name, url] of literals) {
    test(`${name} is refused`, async () => {
      const r = await refusal(() => validateTarget(url, { resolver: failing("DNS must not be consulted") }));
      assert.notEqual(r, "(no refusal)");
    });
  }

  test("the same ranges are refused when they arrive as DNS answers rather than literals", async () => {
    for (const bad of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.0.1"]) {
      const r = await refusal(() => validateTarget("https://provider.example/x", { resolver: resolver([bad]) }));
      assert.match(r, /non-public address/, `${bad} must be refused as a DNS answer`);
    }
  });
});

describe("unusual textual IP encodings are canonicalised or refused, never waved through", () => {
  /**
   * `2130706433`, `0x7f000001` and `0177.0.0.1` are all 127.0.0.1. WHATWG URL parsing normalises them
   * for http/https, so the literal check sees the real address. This asserts the outcome rather than
   * the mechanism: whichever way it happens, none of them may reach a fetch.
   */
  const encodings = [
    "https://2130706433/x",
    "https://0x7f000001/x",
    "https://0177.0.0.1/x",
    "https://127.1/x",
    "https://[::ffff:7f00:1]/x",
  ];

  for (const url of encodings) {
    test(`${url} does not reach the network`, async () => {
      const r = await refusal(() => validateTarget(url, { resolver: failing("DNS must not be consulted") }));
      assert.notEqual(r, "(no refusal)", `${url} was allowed`);
    });
  }
});

describe("hostname rules run before DNS", () => {
  test("localhost suffixes are refused without resolving", async () => {
    for (const h of ["api.localhost", "db.local", "svc.internal", "host.localdomain", "x.home.arpa"]) {
      const r = await refusal(() => validateTarget(`https://${h}/x`, { resolver: failing("must not resolve") }));
      assert.notEqual(r, "(no refusal)", `${h} was allowed`);
    }
  });

  test("a dotless name is refused because search domains decide where it lands", async () => {
    const r = await refusal(() => validateTarget("https://intranet/x", { resolver: failing("must not resolve") }));
    assert.match(r, /search domains/);
  });

  test("isBlockedHostname is exported and deterministic", () => {
    assert.equal(isBlockedHostname("provider.example"), null);
    assert.ok(isBlockedHostname("localhost"));
    assert.ok(isBlockedHostname("LOCALHOST"));
    assert.ok(isBlockedHostname("localhost."), "a trailing root dot must not bypass the check");
  });
});

describe("scheme, credentials and port", () => {
  test("a non-http scheme is refused", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x.example/", "ftp://x.example/"]) {
      const r = await refusal(() => validateTarget(url, { resolver: resolver(PUBLIC_V4) }));
      assert.match(r, /not permitted/);
    }
  });

  test("http is refused by default and permitted only when asked for explicitly", async () => {
    assert.match(await refusal(() => validateTarget("http://provider.example/x", { resolver: resolver(PUBLIC_V4) })), /scheme/);
    const t = await validateTarget("http://provider.example/x", { resolver: resolver(PUBLIC_V4), allowHttp: true });
    assert.equal(t.url.protocol, "http:");
  });

  test("userinfo in the URL is refused", async () => {
    const r = await refusal(() => validateTarget("https://user:pass@provider.example/x", { resolver: resolver(PUBLIC_V4) }));
    assert.match(r, /credentials/);
  });

  test("a disallowed port is refused", async () => {
    const r = await refusal(() => validateTarget("https://provider.example:22/x", { resolver: resolver(PUBLIC_V4) }));
    assert.match(r, /port 22/);
    assert.ok(DEFAULT_ALLOWED_PORTS.has(443));
  });
});

describe("DNS failure modes refuse", () => {
  test("a resolution error refuses", async () => {
    const r = await refusal(() => validateTarget("https://provider.example/x", { resolver: failing("ENOTFOUND") }));
    assert.match(r, /DNS resolution failed/);
  });

  test("a DNS timeout refuses", async () => {
    const slow: HostResolver = () => new Promise((resolve) => setTimeout(() => resolve({ addresses: PUBLIC_V4, cnames: [] }), 200));
    const r = await refusal(() => validateTarget("https://provider.example/x", { resolver: slow, dnsTimeoutMs: 20 }));
    assert.match(r, /DNS resolution failed/);
  });

  test("empty A and AAAA results refuse rather than proceeding", async () => {
    const r = await refusal(() => validateTarget("https://provider.example/x", { resolver: resolver([]) }));
    assert.match(r, /no A or AAAA/);
  });

  test("a CNAME pointing at a private name refuses", async () => {
    const r = await refusal(() =>
      validateTarget("https://provider.example/x", { resolver: resolver(PUBLIC_V4, ["internal.corp.local"]) }),
    );
    assert.match(r, /CNAME/);
  });
});

describe("redirects", () => {
  const okResponse = (body = "{}"): Response => new Response(body, { status: 200 });
  const redirectTo = (location: string, status = 302): Response =>
    new Response(null, { status, headers: { location } });

  test("by default a redirect is refused, preserving the Node guard's behaviour", async () => {
    let calls = 0;
    const r = await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: async () => {
          calls += 1;
          return redirectTo("https://elsewhere.example/y");
        },
      }),
    );
    assert.match(r, /redirects are not followed/);
    assert.equal(calls, 1, "the redirect target was never fetched");
  });

  test("a public-to-public redirect succeeds when following is enabled", async () => {
    const seen: string[] = [];
    const out = await guardedFetch("https://provider.example/x", {
      method: "GET",
      timeoutMs: 1000,
      maxRedirects: 3,
      resolver: resolver(PUBLIC_V4),
      fetchImpl: async (input) => {
        seen.push(String(input));
        return seen.length === 1 ? redirectTo("https://provider.example/final") : okResponse('{"ok":true}');
      },
    });
    assert.equal(out.status, 200);
    assert.equal(out.finalUrl, "https://provider.example/final");
    assert.equal(out.hops.length, 2);
  });

  /**
   * The attack the whole re-validation exists for: a hostname that passes on the first hop and sends
   * you inward on the second. Validating only the original URL would let this through.
   */
  test("a redirect to a private destination refuses on the second hop", async () => {
    let calls = 0;
    const r = await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        maxRedirects: 3,
        resolver: async (hostname) =>
          hostname === "provider.example" ? { addresses: PUBLIC_V4, cnames: [] } : { addresses: ["169.254.169.254"], cnames: [] },
        fetchImpl: async () => {
          calls += 1;
          return redirectTo("https://metadata.example/latest/meta-data/");
        },
      }),
    );
    assert.match(r, /non-public address/);
    assert.equal(calls, 1, "the private destination was never fetched");
  });

  test("a redirect to localhost refuses", async () => {
    const r = await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        maxRedirects: 3,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: async () => redirectTo("https://localhost:443/admin"),
      }),
    );
    assert.notEqual(r, "(no refusal)");
  });

  test("excessive redirects refuse", async () => {
    const r = await refusal(() =>
      guardedFetch("https://provider.example/0", {
        method: "GET",
        timeoutMs: 1000,
        maxRedirects: 2,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: async (input) => redirectTo(`https://provider.example/${Number(String(input).split("/").pop()) + 1}`),
      }),
    );
    assert.match(r, /too many redirects/);
  });

  test("a redirect loop refuses rather than spinning", async () => {
    const r = await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        maxRedirects: 5,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: async () => redirectTo("https://provider.example/x"),
      }),
    );
    assert.match(r, /redirect loop/);
  });

  test("a redirect with no Location refuses", async () => {
    const r = await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        maxRedirects: 3,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: async () => new Response(null, { status: 302 }),
      }),
    );
    assert.match(r, /no Location/);
  });

  test("a protocol-relative Location resolves against the current URL and cannot change scheme", async () => {
    const seen: string[] = [];
    await guardedFetch("https://provider.example/x", {
      method: "GET",
      timeoutMs: 1000,
      maxRedirects: 2,
      resolver: resolver(PUBLIC_V4),
      fetchImpl: async (input) => {
        seen.push(String(input));
        return seen.length === 1 ? redirectTo("//provider.example/next") : okResponse();
      },
    });
    assert.equal(seen[1], "https://provider.example/next", "// inherited https, not something weaker");
  });

  test("sensitive headers are stripped when the origin changes, and kept when it does not", () => {
    const from = new URL("https://a.example/x");
    const sameOrigin = new URL("https://a.example/y");
    const crossOrigin = new URL("https://b.example/y");
    const headers = { authorization: "Bearer t", cookie: "s=1", "x-payment": "p", accept: "application/json" };

    assert.deepEqual(headersForRedirect(headers, from, sameOrigin), headers, "same origin keeps them");

    const stripped = headersForRedirect(headers, from, crossOrigin);
    assert.equal(stripped.authorization, undefined);
    assert.equal(stripped.cookie, undefined);
    assert.equal(stripped["x-payment"], undefined);
    assert.equal(stripped.accept, "application/json", "ordinary headers survive");
  });
});

describe("response limits", () => {
  test("an oversized response refuses", async () => {
    const big = new Uint8Array(5000);
    const r = await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        maxBytes: 1000,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: async () => new Response(big, { status: 200 }),
      }),
    );
    assert.match(r, /exceeded 1000 bytes/);
  });

  test("a response timeout aborts the request", async () => {
    let aborted = false;
    await assert.rejects(
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 20,
        resolver: resolver(PUBLIC_V4),
        fetchImpl: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      }),
    );
    assert.equal(aborted, true, "the timeout must actually abort the in-flight request");
  });

  test("exactly one request is made for one approved call, and none after a refusal", async () => {
    let calls = 0;
    const count = async (): Promise<Response> => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    await guardedFetch("https://provider.example/x", {
      method: "GET",
      timeoutMs: 1000,
      resolver: resolver(PUBLIC_V4),
      fetchImpl: count,
    });
    assert.equal(calls, 1);

    await refusal(() =>
      guardedFetch("https://provider.example/x", {
        method: "GET",
        timeoutMs: 1000,
        resolver: resolver(["10.0.0.1"]),
        fetchImpl: count,
      }),
    );
    assert.equal(calls, 1, "a guard refusal must not reach the provider at all");
  });
});

describe("the classifiers are independently testable", () => {
  test("IPv4 classification", () => {
    assert.equal(isBlockedIpv4("93.184.216.34"), false);
    assert.equal(isBlockedIpv4("8.8.8.8"), false);
    for (const bad of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1", "100.64.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255"]) {
      assert.equal(isBlockedIpv4(bad), true, `${bad} must be blocked`);
    }
    assert.equal(isBlockedIpv4("999.1.1.1"), true, "unparseable is blocked, not allowed");
  });

  test("IPv6 classification, including embedded IPv4", () => {
    assert.equal(isBlockedIpv6("2606:2800:220:1:248:1893:25c8:1946"), false);
    for (const bad of ["::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2002:0a00:0001::1"]) {
      assert.equal(isBlockedIpv6(bad), true, `${bad} must be blocked`);
    }
    assert.equal(isBlockedIpv6("not-an-address"), true);
  });

  test("isBlockedAddress refuses anything that is not an address", () => {
    assert.equal(isBlockedAddress("provider.example"), true);
    assert.equal(isBlockedAddress(""), true);
  });
});
