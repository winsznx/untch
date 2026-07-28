/**
 * The hardened outbound HTTP client — the single door every provider call goes through.
 *
 * Everything the Consumer Pack fetches from the outside world passes through `providerFetch`, and it
 * is deliberately hostile to its own callers:
 *
 *   • SSRF. The base URL comes from `consumer_providers.base_url`, never from a request. On top of
 *     that, the resolved IP is checked against the private/loopback/link-local/CGNAT ranges BEFORE
 *     the request goes out, so a provider hostname that later resolves to 169.254.169.254 (cloud
 *     metadata) or 127.0.0.1 is refused rather than fetched. DNS is re-checked per request; a TOCTOU
 *     window remains and is documented rather than papered over — closing it fully needs a pinned
 *     socket, which is a bigger change than this control is worth today.
 *   • Redirects are NOT followed. A provider that 302s us somewhere is a provider whose response we
 *     did not ask for. `redirect: "manual"` and a typed refusal.
 *   • Response size is capped by streaming and counting, not by trusting content-length.
 *   • Timeouts are per-request and always set. There is no un-timed provider call.
 *   • Everything is redacted on the way to a log: addresses shortened, bodies dropped, headers
 *     allowlisted. Provider text is data and is never interpolated into a log line raw.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizedError, ProviderError, sanitizeProviderText } from "@untch/consumer-core";

export interface ProviderFetchOptions {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  /** Hard cap on the response body. Defaults to 1 MiB — a product listing, not a file transfer. */
  readonly maxBytes?: number;
  readonly correlationId?: string;
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to a real DNS lookup. */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
}

export interface ProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly url: string;
  readonly durationMs: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Response headers we are willing to read. Everything else is dropped before it reaches any caller. */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "retry-after",
  "payment-required",
  "payment-response",
  "www-authenticate",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "location",
]);

export class SsrfRefusedError extends Error {
  constructor(host: string, reason: string) {
    super(`refusing to fetch ${host}: ${reason}`);
    this.name = "SsrfRefusedError";
  }
}

/**
 * IPv4/IPv6 ranges that must never be a provider target. The cloud metadata endpoint
 * (169.254.169.254) falls inside link-local and is the reason this list is not optional.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  // Not an IP at all — refuse rather than guess.
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local — includes cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments / 192.0.0.0/24 + TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) must be judged by its IPv4 rules, not waved through.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);
  return false;
}

async function defaultResolveHost(host: string): Promise<readonly string[]> {
  if (isIP(host) !== 0) return [host];
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * Validate a URL before it is fetched. Exported so the provider-registry admin surface can run the
 * same check when an operator sets a base URL, rather than discovering the problem at request time.
 */
export async function assertFetchable(
  rawUrl: string,
  resolveHost: (host: string) => Promise<readonly string[]> = defaultResolveHost,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfRefusedError(sanitizeProviderText(rawUrl, 120), "not a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    // http: would expose the payment header in transit. There is no provider worth that.
    throw new SsrfRefusedError(url.host, `scheme ${url.protocol} is not permitted (https only)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SsrfRefusedError(url.host, "URL credentials are not permitted");
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHost(url.hostname);
  } catch (err) {
    throw new SsrfRefusedError(url.host, `DNS resolution failed: ${(err as Error).message}`);
  }
  if (addresses.length === 0) {
    throw new SsrfRefusedError(url.host, "DNS returned no addresses");
  }
  // EVERY resolved address must be public. One blocked record is enough to refuse: a DNS-rebinding
  // attacker only needs the connection to pick the bad one.
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new SsrfRefusedError(url.host, `resolves to a non-public address (${redactIp(addr)})`);
    }
  }
  return url;
}

function redactIp(ip: string): string {
  const v4 = ip.split(".");
  if (v4.length === 4) return `${v4[0]}.${v4[1]}.x.x`;
  return `${ip.split(":").slice(0, 2).join(":")}:…`;
}

export async function providerFetch(opts: ProviderFetchOptions): Promise<ProviderResponse> {
  const url = await assertFetchable(opts.url, opts.resolveHost ?? defaultResolveHost);
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const startedAt = Date.now();

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "untch-consumer-pack/1.0",
      ...(opts.correlationId ? { "x-correlation-id": opts.correlationId } : {}),
      ...(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    const res = await doFetch(url.toString(), {
      method: opts.method,
      headers,
      signal: controller.signal,
      // A provider that redirects us is sending us somewhere we did not agree to go.
      redirect: "manual",
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });

    if (res.status >= 300 && res.status < 400) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_BAD_REQUEST",
          `provider returned a ${res.status} redirect; redirects are not followed`,
          { httpStatus: res.status },
        ),
      );
    }

    const text = await readCapped(res, maxBytes);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (HEADER_ALLOWLIST.has(k)) outHeaders[k] = value;
    });

    return {
      status: res.status,
      headers: outHeaders,
      text,
      url: url.toString(),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof SsrfRefusedError) throw err;
    const aborted =
      (err as { name?: string }).name === "AbortError" || (err as { name?: string }).name === "TimeoutError";
    if (aborted) {
      // A timeout on a NON-idempotent call is the canonical ambiguous outcome: the provider may
      // well have acted. Classified as ambiguous, never as retryable.
      throw new ProviderError(
        normalizedError(
          "PROVIDER_AMBIGUOUS",
          `provider did not respond within ${opts.timeoutMs}ms — the outcome is unknown`,
        ),
      );
    }
    throw new ProviderError(
      normalizedError("PROVIDER_UNAVAILABLE", `transport error: ${(err as Error).message}`),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the body with a hard byte cap, counting what actually arrives rather than believing
 * `content-length`. A provider that lies about its length cannot make us buffer a gigabyte.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderError(
          normalizedError(
            "PROVIDER_MALFORMED_RESPONSE",
            `provider response exceeded ${maxBytes} bytes and was discarded`,
            { httpStatus: res.status },
          ),
        );
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Parse a JSON body, treating anything unparseable as an untrusted response rather than throwing raw. */
export function parseJsonBody(res: ProviderResponse): unknown {
  if (res.text.trim() === "") return null;
  try {
    return JSON.parse(res.text) as unknown;
  } catch {
    throw new ProviderError(
      normalizedError("PROVIDER_MALFORMED_RESPONSE", "provider response was not valid JSON", {
        httpStatus: res.status,
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction
// ─────────────────────────────────────────────────────────────────────────────

/** `0x1234…abcd`. Enough to correlate two log lines, not enough to identify a wallet. */
export function redactAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  const t = addr.trim();
  if (t.length <= 12) return "…";
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

export function redactEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return "…";
  return `${email.slice(0, 1)}…@${email.slice(at + 1)}`;
}

/**
 * The single redactor every consumer log line goes through. Any key whose NAME suggests it carries a
 * secret, a payment payload, or personal data is dropped entirely — matching on the key rather than
 * on the value, so an unrecognised secret format is still caught.
 */
const DROP_KEYS = /^(authorization|cookie|set-cookie|x-payment|payment|paymentheader|sign-in-with-x|signature|secret|privatekey|private_key|seed|mnemonic|password|html|text|attachments|body)$/i;
const ADDRESS_KEYS = /(address|recipient|payto|payer|wallet|from|to)$/i;
const EMAIL_KEYS = /email/i;

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeProviderText(value, 160);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactForLog(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string" && ADDRESS_KEYS.test(k)) {
      out[k] = redactAddress(v);
      continue;
    }
    if (typeof v === "string" && EMAIL_KEYS.test(k)) {
      out[k] = redactEmail(v);
      continue;
    }
    out[k] = redactForLog(v, depth + 1);
  }
  return out;
}
