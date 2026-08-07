/**
 * Live domain availability via RDAP (no registrar account required).
 * Availability is best-effort: 404 / not-found ⇒ available; 200 ⇒ taken; network errors ⇒ unknown.
 */

export type DomainStatus = "AVAILABLE" | "TAKEN" | "UNKNOWN";

export type DomainResult = {
  readonly domain: string;
  readonly available: boolean | null;
  readonly status: DomainStatus;
  readonly source: "rdap";
  readonly checkedAt: string;
  readonly detail?: string;
  /**
   * Why the answer is UNKNOWN, in a form a caller can branch on.
   *
   * `detail` is prose for a human reading a response; this is the stable token. A client deciding
   * whether to retry needs to tell "nobody answered" from "this TLD is not supported" without parsing
   * an English sentence that may be reworded.
   */
  readonly reason?: "INVALID_DOMAIN" | "UNSUPPORTED_TLD" | "NO_RDAP_SOURCE_ANSWERED";
};

/**
 * Direct registry endpoints, each checked against a known-registered and a known-unregistered name.
 *
 * `xyz`, `dev` and `app` were previously absent and fell through to the `rdap.org` proxy, on the
 * belief that CentralNic answered 400 to everything. That was true of the base then in use and is not
 * true of the one IANA actually publishes: `https://rdap.centralnic.com/xyz/` returns 200 for a
 * registered name and 404 for a free one, and Google's registry does the same for `dev` and `app`.
 *
 * That mattered more than a missing TLD normally would. The proxy answers 403 to Cloudflare's egress,
 * so once the ASP moved to Workers every `.xyz` lookup came back UNKNOWN — including `untch.xyz`, the
 * one domain a reviewer is most likely to type. Going to the authoritative server fixes the answer and
 * removes a third party from the path at the same time.
 */
const TLD_RDAP: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/domain/",
  net: "https://rdap.verisign.com/net/v1/domain/",
  org: "https://rdap.publicinterestregistry.org/rdap/domain/",
  ai: "https://rdap.identitydigital.services/rdap/domain/",
  xyz: "https://rdap.centralnic.com/xyz/domain/",
  dev: "https://pubapi.registry.google/rdap/domain/",
  app: "https://pubapi.registry.google/rdap/domain/",
};

/**
 * IANA's own registry map, consulted only when the direct endpoint fails to answer.
 *
 * This is the standards-based discovery RFC 9224 defines: IANA publishes which server is authoritative
 * for each TLD, and following it is how a lookup stays correct when a registry moves. It is a FALLBACK
 * rather than the primary path because the static table above is already verified and costs no extra
 * round trip — and because a bootstrap fetch that fails must not take a working lookup down with it.
 *
 * Cached for the life of the process. The document changes on the order of weeks, and re-fetching it
 * per domain would turn one lookup into two.
 */
const IANA_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

let bootstrapCache: Promise<Map<string, string>> | null = null;

async function bootstrapBases(timeoutMs: number): Promise<Map<string, string>> {
  bootstrapCache ??= (async () => {
    const res = await fetch(IANA_BOOTSTRAP, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`iana bootstrap http ${res.status}`);
    const doc = (await res.json()) as { services?: [string[], string[]][] };
    const map = new Map<string, string>();
    for (const [tlds, servers] of doc.services ?? []) {
      const server = servers.find((s) => s.startsWith("https://"));
      if (!server) continue;
      for (const tld of tlds) map.set(tld.toLowerCase(), `${server.replace(/\/$/, "")}/domain/`);
    }
    return map;
  })().catch((err: unknown) => {
    // Cleared so one failed fetch does not disable discovery for the whole process.
    bootstrapCache = null;
    throw err;
  });
  return bootstrapCache;
}

/** Last resort, and a third party rather than a registry — hence last. */
const RDAP_PROXY = "https://rdap.org/domain/";

/**
 * The TLDs whose RDAP answer is trusted, and nothing else.
 *
 * The reason this list has to exist is `.io`. Its registry publishes no usable RDAP, so every `.io`
 * lookup — registered or not — comes back 404. A 404 is the signal for "no such registration", so an
 * unfiltered reading reports `google.io` as available. The failure is not that the server is wrong;
 * it is that a 404 means two different things depending on whether the TLD is served at all, and
 * nothing in the response distinguishes them.
 *
 * Each entry below was checked against a known-registered and a known-unregistered name and answered
 * 200 and 404 respectively. Anything absent is reported UNKNOWN, which is the true answer: this
 * service does not know, and saying so is the only thing it can do that is not a guess.
 */
const TRUSTED_TLDS: ReadonlySet<string> = new Set(["com", "net", "org", "xyz", "ai", "dev", "app"]);

function splitDomain(domain: string): { sld: string; tld: string } | null {
  const d = domain.toLowerCase().replace(/\.$/, "").trim();
  const parts = d.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const tld = parts[parts.length - 1]!;
  return { sld: parts.slice(0, -1).join("."), tld };
}

async function rdapLookup(domain: string, timeoutMs: number): Promise<DomainResult> {
  const checkedAt = new Date().toISOString();
  const split = splitDomain(domain);
  if (!split) {
    return {
      domain,
      available: null,
      status: "UNKNOWN",
      source: "rdap",
      checkedAt,
      reason: "INVALID_DOMAIN",
      detail: "invalid domain",
    };
  }

  if (!TRUSTED_TLDS.has(split.tld)) {
    return {
      domain,
      available: null,
      status: "UNKNOWN",
      source: "rdap",
      checkedAt,
      reason: "UNSUPPORTED_TLD",
      detail: `no trusted RDAP source for .${split.tld}`,
    };
  }

  /**
   * One attempt against one server. Returns null when the server did not answer the question, so the
   * caller can try the next source rather than reporting a transport failure as a registration fact.
   */
  const attempt = async (base: string): Promise<DomainResult | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${encodeURIComponent(domain.toLowerCase())}`, {
        method: "GET",
        headers: { accept: "application/rdap+json, application/json" },
        signal: ctrl.signal,
        redirect: "follow",
      });

      if (res.status === 404 || res.status === 204) {
        return { domain, available: true, status: "AVAILABLE", source: "rdap", checkedAt };
      }
      if (res.status === 200) {
        // Some registries return 200 with errorCode for not found
        const body = (await res.json().catch(() => null)) as { errorCode?: number; title?: string } | null;
        if (body && (body.errorCode === 404 || /not found/i.test(String(body.title ?? "")))) {
          return { domain, available: true, status: "AVAILABLE", source: "rdap", checkedAt };
        }
        return { domain, available: false, status: "TAKEN", source: "rdap", checkedAt };
      }
      /**
       * A 400 is NOT an answer, and reading it as one produced a false claim.
       *
       * This branch used to return AVAILABLE for 400 and 422 on the theory that some registries answer
       * an unregistered name that way. Checked against the real servers, that is false: the `.xyz`
       * endpoint then in use returned 400 for a REGISTERED domain and 400 for an unregistered one
       * alike, so the rule reported every `.xyz` in existence as available. `untch.xyz` — this
       * project's own live domain — came back AVAILABLE.
       *
       * 404 is the RDAP signal for "no such registration". Everything else means the server did not
       * answer, which is what the next source is for.
       */
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Authoritative first, then IANA discovery, then the proxy.
   *
   * Ordered by how close each is to the registry. Falling forward only on a NON-answer means a
   * registry that says "no such domain" is believed immediately — a second opinion on a 404 could only
   * ever turn a correct answer into a wrong one.
   */
  const direct = TLD_RDAP[split.tld];
  if (direct) {
    const answer = await attempt(direct);
    if (answer) return answer;
  }

  let discovered: string | undefined;
  try {
    discovered = (await bootstrapBases(timeoutMs)).get(split.tld);
    if (discovered && discovered !== direct) {
      const answer = await attempt(discovered);
      if (answer) return answer;
    }
  } catch {
    // Discovery is a fallback; its failure must not remove the proxy attempt below.
  }

  const viaProxy = await attempt(RDAP_PROXY);
  if (viaProxy) return viaProxy;

  return {
    domain,
    available: null,
    status: "UNKNOWN",
    source: "rdap",
    checkedAt,
    /**
     * Machine-readable, because "UNKNOWN" alone tells a caller nothing they can act on. This says the
     * question was asked of every source this service trusts and none of them answered it — which is
     * a different fact from a malformed name or an unsupported TLD, both of which return above.
     */
    reason: "NO_RDAP_SOURCE_ANSWERED",
    detail: `no RDAP source answered for .${split.tld} (tried ${[direct, discovered, RDAP_PROXY].filter(Boolean).length} endpoints)`,
  };
}

/** Check up to `limit` domains with bounded concurrency. */
export async function checkDomainsLive(
  domains: readonly string[],
  opts: { timeoutMs?: number; concurrency?: number } = {},
): Promise<DomainResult[]> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const concurrency = opts.concurrency ?? 4;
  const queue = [...domains];
  const out: DomainResult[] = [];

  async function worker() {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      out.push(await rdapLookup(next, timeoutMs));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, domains.length) }, () => worker());
  await Promise.all(workers);
  // Preserve input order
  const byDomain = new Map(out.map((r) => [r.domain.toLowerCase(), r]));
  return domains.map(
    (d) =>
      byDomain.get(d.toLowerCase()) ?? {
        domain: d,
        available: null,
        status: "UNKNOWN" as const,
        source: "rdap" as const,
        checkedAt: new Date().toISOString(),
      },
  );
}

/** `.io` was here and is gone: no trusted RDAP source, so it could only ever answer UNKNOWN. */
export const DEFAULT_TLDS = [".com", ".xyz", ".ai", ".dev", ".app"] as const;
