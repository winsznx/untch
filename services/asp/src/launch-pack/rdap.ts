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
};

/**
 * Direct registry endpoints, and only the ones that were checked against a known-registered and a
 * known-unregistered name.
 *
 * Four entries were removed because they do not work. `xyz` (CentralNic) answers 400 to everything.
 * `io`, `dev` and `app` did not connect at all. Each of those now falls through to the bootstrap
 * below, which follows IANA's registry map to whichever server is actually authoritative and was
 * verified returning 200 for a registered name and 404 for a free one across every TLD here.
 *
 * A direct base is kept only where it is both correct and closer to the registry than the bootstrap.
 */
const TLD_RDAP: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/domain/",
  net: "https://rdap.verisign.com/net/v1/domain/",
  org: "https://rdap.publicinterestregistry.org/rdap/domain/",
  ai: "https://rdap.identitydigital.services/rdap/domain/",
};

/** Bootstrap fallback when TLD has no dedicated base. */
const RDAP_BOOTSTRAP = "https://rdap.org/domain/";

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
      detail: `no trusted RDAP source for .${split.tld}`,
    };
  }

  const base = TLD_RDAP[split.tld] ?? RDAP_BOOTSTRAP;
  const url = `${base}${encodeURIComponent(domain.toLowerCase())}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
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
     * an unregistered name that way. Checked against the real servers, that is false: CentralNic's
     * `.xyz` endpoint returns 400 for a REGISTERED domain and 400 for an unregistered one alike, so
     * the rule reported every `.xyz` in existence as available. `untch.xyz` — this project's own
     * live domain — came back AVAILABLE.
     *
     * 404 is the RDAP signal for "no such registration". Everything else in the 4xx range means the
     * server did not answer the question, which is exactly what UNKNOWN is for.
     */
    return {
      domain,
      available: null,
      status: "UNKNOWN",
      source: "rdap",
      checkedAt,
      detail: `rdap http ${res.status}`,
    };
  } catch (err) {
    return {
      domain,
      available: null,
      status: "UNKNOWN",
      source: "rdap",
      checkedAt,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
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
