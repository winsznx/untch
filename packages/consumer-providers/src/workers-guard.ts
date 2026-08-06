/**
 * The outbound-request guard, on Cloudflare Workers.
 *
 * WHY THE RESOLUTION CALL CHANGED
 *
 * The Node guard resolves names with `lookup` from `node:dns/promises`. Cloudflare's documentation
 * states that under `nodejs_compat` every `node:dns` function works EXCEPT `lookup`, `lookupService`
 * and `resolve`, which throw "Not implemented".
 *
 * That is not what the runtime does today. A probe deployed to workers.dev on 2026-08-06 found
 * `dns.promises.lookup("cloudflare.com")` returning `{ address: "104.16.132.229", family: 4 }`, and
 * `resolve` failing for an unrelated reason (it demands an explicit rrtype) rather than as
 * unimplemented. So the documented restriction is stale, and a port built on "lookup would throw"
 * would be built on a false premise.
 *
 * `lookup` is still not used, for two reasons that survive the correction. Depending on undocumented
 * behaviour for a SECURITY control is unsound — the docs describe it as unimplemented, so it may be
 * withdrawn without notice, and a guard that silently stops resolving is a guard that is off. And
 * `lookup` returns whatever the resolver decides is best, whereas this control has to see BOTH the A
 * and the AAAA answers to refuse a host that resolves publicly on one family and privately on the
 * other. `resolve4`/`resolve6`/`resolveCname` and `net.isIP` are all documented, all verified working
 * on the real runtime, and give exactly that visibility.
 *
 * WHAT IS DELIBERATELY NOT WEAKENED
 *
 * The Node guard refuses EVERY redirect, with a stated reason: a provider that 302s us is sending us
 * somewhere we did not agree to go. That default is preserved exactly. Bounded redirect following
 * exists here as an OPT-IN (`maxRedirects > 0`), and when enabled every hop is re-validated from the
 * beginning — parse, scheme, credentials, hostname, literal-address rules, port, and a fresh DNS
 * check of every A and AAAA answer. Validating only the original URL protects nothing, because the
 * interesting attack is precisely a public hostname that redirects inward.
 *
 * Cloudflare blocks some egress to internal space on its own. That is defence in depth and is not a
 * substitute for this: the metadata-style targets that matter are reachable from plenty of places,
 * and a control that only works on one host is not a control.
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export class OutboundRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`refusing to fetch ${host}: ${reason}`);
    this.name = "OutboundRefusedError";
  }
}

/** Ports a provider may be reached on. Anything else is refused rather than attempted. */
export const DEFAULT_ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 8443]);

/** Headers that must never survive a redirect to a different origin. */
const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "payment-signature",
  "x-payment",
  "x-api-key",
  "x-untch-operator-token",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Address classification
// ─────────────────────────────────────────────────────────────────────────────

const v4Octets = (ip: string): [number, number, number, number] | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
};

/**
 * Every IPv4 range that is not ordinary public internet.
 *
 * 169.254.0.0/16 is the one to keep in mind when editing: cloud metadata lives at 169.254.169.254,
 * and it is the single most valuable target an SSRF has.
 */
export function isBlockedIpv4(ip: string): boolean {
  const octets = v4Octets(ip);
  if (!octets) return true;
  const [a, b, c] = octets;

  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // RFC1918
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 192 && b === 0) return true;             // IETF protocol assignments + TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;         // TEST-NET-2 (documentation)
  if (a === 203 && b === 0 && c === 113) return true;          // TEST-NET-3 (documentation)
  if (a >= 224) return true;                         // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 literal to eight 16-bit groups. Returns null when it is not parseable. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  // A trailing dotted quad (::ffff:1.2.3.4, ::1.2.3.4, 2002::1.2.3.4) becomes two groups.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted?.[1]) {
    const o = v4Octets(dotted[1]);
    if (!o) return null;
    s = s.slice(0, dotted.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter((x) => x !== "") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((x) => x !== "") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8) return null;

  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return groups.some((n) => Number.isNaN(n)) ? null : groups;
}

/**
 * Every IPv6 range that is not ordinary public internet, including the forms that SMUGGLE an IPv4
 * address inside an IPv6 one. `::ffff:127.0.0.1` is loopback wearing a different hat, and a guard
 * that checks only the textual prefix waves it through.
 */
export function isBlockedIpv6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;

  const isZeroPrefix = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  const asV4 = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  if (g.every((x) => x === 0)) return true;                               // ::
  if (isZeroPrefix(7) && g[7] === 1) return true;                         // ::1 loopback
  if ((g[0]! & 0xffc0) === 0xfe80) return true;                           // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true;                           // fc00::/7 unique local
  if ((g[0]! & 0xff00) === 0xff00) return true;                           // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                    // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;                    // 2001::/32 Teredo

  // IPv4-mapped ::ffff:0:0/96 and the deprecated IPv4-compatible ::/96 — judged by IPv4 rules.
  if (isZeroPrefix(5) && g[5] === 0xffff) return isBlockedIpv4(asV4(g[6]!, g[7]!));
  if (isZeroPrefix(6) && !(g[6] === 0 && g[7] === 0)) return isBlockedIpv4(asV4(g[6]!, g[7]!));
  // 64:ff9b::/96 NAT64 — likewise carries an embedded IPv4 destination.
  if (g[0] === 0x0064 && g[1] === 0xff9b && isZeroPrefix(2) === false && g[2] === 0) {
    return isBlockedIpv4(asV4(g[6]!, g[7]!));
  }
  // 2002::/16 6to4 embeds the IPv4 address in groups 1-2.
  if (g[0] === 0x2002) return isBlockedIpv4(asV4(g[1]!, g[2]!));

  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not an address at all — refuse rather than guess
}

// ─────────────────────────────────────────────────────────────────────────────
// Hostname rules
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"] as const;

/**
 * Names that must never be resolved at all, checked before DNS rather than after.
 *
 * A dotless name is refused because it resolves through search domains, and what it lands on depends
 * on the resolver's configuration rather than on anything stated in the URL.
 */
export function isBlockedHostname(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "") return "empty hostname";
  if (h === "localhost") return "localhost is not a permitted target";
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return `${h} is a local-network name`;
  if (!h.includes(".") && isIP(h) === 0) return "dotless hostnames resolve through search domains";
  if (/[\s_]/.test(h)) return "malformed hostname";
  return null;
}

export interface GuardOptions {
  readonly allowedPorts?: ReadonlySet<number>;
  /** 0 preserves the Node guard's behaviour: redirects are refused, never followed. */
  readonly maxRedirects?: number;
  readonly dnsTimeoutMs?: number;
  readonly allowHttp?: boolean;
  readonly resolver?: HostResolver;
}

export interface ResolvedHost {
  readonly addresses: readonly string[];
  readonly cnames: readonly string[];
}

export type HostResolver = (hostname: string, timeoutMs: number) => Promise<ResolvedHost>;

const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Resolve with the calls Workers actually implements.
 *
 * `resolve4`/`resolve6` rather than `lookup`, because `lookup` throws "Not implemented" here. Both
 * are asked, and an error from either is tolerated only when the OTHER returned something: a host
 * with no AAAA record is ordinary, a host with neither is not resolvable and must be refused.
 */
export const workersResolver: HostResolver = async (hostname, timeoutMs) => {
  const settle = async (p: Promise<string[]>): Promise<string[]> => {
    try {
      return await withTimeout(p, timeoutMs, "DNS resolution");
    } catch (err) {
      if (/timed out/.test((err as Error).message)) throw err;
      return [];
    }
  };

  const [v4, v6, cnames] = await Promise.all([
    settle(dns.resolve4(hostname)),
    settle(dns.resolve6(hostname)),
    settle(dns.resolveCname(hostname) as Promise<string[]>),
  ]);

  return { addresses: [...v4, ...v6], cnames };
};

export interface ValidatedTarget {
  readonly url: URL;
  readonly addresses: readonly string[];
}

/**
 * Validate one URL completely: shape, scheme, credentials, hostname, literal address, port, and every
 * address DNS returns for it.
 *
 * Exported so a redirect hop and an operator setting a base URL both run the identical check. A
 * redirect validated by a weaker path is the whole attack.
 */
export async function validateTarget(rawUrl: string, options: GuardOptions = {}): Promise<ValidatedTarget> {
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? 3_000;
  const resolver = options.resolver ?? workersResolver;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundRefusedError(String(rawUrl).slice(0, 120), "not a valid absolute URL");
  }

  const httpsOnly = options.allowHttp !== true;
  if (httpsOnly ? url.protocol !== "https:" : url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OutboundRefusedError(url.host, `scheme ${url.protocol} is not permitted`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new OutboundRefusedError(url.host, "URL credentials are not permitted");
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!allowedPorts.has(port)) {
    throw new OutboundRefusedError(url.host, `port ${port} is not permitted`);
  }

  /**
   * `new URL` has already canonicalised `0x7f.1`, `2130706433` and `0177.0.0.1` into dotted-quad form
   * for these schemes, so the literal check below sees the real address rather than the encoding.
   */
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const badName = isBlockedHostname(hostname);
  if (badName) throw new OutboundRefusedError(url.host, badName);

  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new OutboundRefusedError(url.host, `literal address ${redactIp(hostname)} is not permitted`);
    }
    return { url, addresses: [hostname] };
  }

  let resolved: ResolvedHost;
  try {
    /**
     * The deadline is enforced HERE, not only inside the default resolver.
     *
     * `workersResolver` bounds its own calls, but a resolver supplied by a caller or a test would
     * otherwise run unbounded, and a guard whose DNS step can hang forever is a guard that turns into
     * a request timeout somewhere far away from the reason. The outer race makes the bound a property
     * of the guard rather than of whichever resolver happens to be installed.
     */
    resolved = await withTimeout(resolver(hostname, dnsTimeoutMs), dnsTimeoutMs, "DNS resolution");
  } catch (err) {
    throw new OutboundRefusedError(url.host, `DNS resolution failed: ${(err as Error).message}`);
  }

  /**
   * A CNAME target is checked as a NAME too. `provider.example` → `internal.corp.local` is a private
   * destination whose A record may well be public-looking by the time anyone checks.
   */
  for (const cname of resolved.cnames) {
    const bad = isBlockedHostname(cname.replace(/\.$/, ""));
    if (bad) throw new OutboundRefusedError(url.host, `CNAME points at ${bad}`);
  }

  if (resolved.addresses.length === 0) {
    throw new OutboundRefusedError(url.host, "DNS returned no A or AAAA records");
  }

  /**
   * EVERY answer must be public. One bad record is enough to refuse, because a DNS-rebinding attacker
   * only needs the connection to pick that one.
   */
  for (const addr of resolved.addresses) {
    if (isBlockedAddress(addr)) {
      throw new OutboundRefusedError(url.host, `resolves to a non-public address (${redactIp(addr)})`);
    }
  }

  return { url, addresses: resolved.addresses };
}

export function redactIp(ip: string): string {
  const v4 = ip.split(".");
  if (v4.length === 4) return `${v4[0]}.${v4[1]}.x.x`;
  return `${ip.split(":").slice(0, 2).join(":")}:…`;
}

/** Strip credentials when a redirect crosses to a different origin. */
export function headersForRedirect(
  headers: Readonly<Record<string, string>>,
  from: URL,
  to: URL,
): Record<string, string> {
  const sameOrigin = from.protocol === to.protocol && from.host === to.host;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!sameOrigin && (SENSITIVE_HEADERS as readonly string[]).includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

export interface GuardedFetchOptions extends GuardOptions {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Typed as the fetch body union without naming BodyInit, which this package's lib does not declare. */
  readonly body?: string | Uint8Array | ArrayBuffer | ReadableStream | undefined;
  readonly timeoutMs: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface GuardedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  readonly finalUrl: string;
  readonly hops: readonly string[];
}

/**
 * Fetch through the guard.
 *
 * `redirect: "manual"` always. With `maxRedirects` at its default of 0 a 3xx is refused outright,
 * which is the Node guard's behaviour. Above 0, each hop is re-validated by `validateTarget` from the
 * beginning and sensitive headers are dropped on any origin change.
 */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const maxRedirects = opts.maxRedirects ?? 0;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const doFetch = opts.fetchImpl ?? fetch;

  let current = rawUrl;
  let headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const hops: string[] = [];
  const seen = new Set<string>();

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url } = await validateTarget(current, opts);
    const key = url.toString();
    if (seen.has(key)) throw new OutboundRefusedError(url.host, "redirect loop");
    seen.add(key);
    hops.push(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await doFetch(key, {
        method: opts.method,
        headers,
        signal: controller.signal,
        redirect: "manual",
        ...(opts.body === undefined ? {} : { body: opts.body }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 300 || res.status >= 400) {
      return { status: res.status, headers: res.headers, bytes: await readCapped(res, maxBytes), finalUrl: key, hops };
    }

    if (hop === maxRedirects) {
      throw new OutboundRefusedError(url.host, maxRedirects === 0 ? "redirects are not followed" : "too many redirects");
    }

    const location = res.headers.get("location");
    if (!location) throw new OutboundRefusedError(url.host, `${res.status} redirect with no Location`);

    let next: URL;
    try {
      // Resolved against the current URL, so a protocol-relative or relative Location cannot smuggle
      // in a scheme of its own choosing.
      next = new URL(location, url);
    } catch {
      throw new OutboundRefusedError(url.host, "redirect Location is not a valid URL");
    }
    headers = headersForRedirect(headers, url, next);
    current = next.toString();
  }

  throw new OutboundRefusedError(new URL(rawUrl).host, "too many redirects");
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OutboundRefusedError(res.url || "(response)", `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}
