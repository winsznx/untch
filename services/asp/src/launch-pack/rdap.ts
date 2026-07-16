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

const TLD_RDAP: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/domain/",
  net: "https://rdap.verisign.com/net/v1/domain/",
  org: "https://rdap.publicinterestregistry.org/rdap/domain/",
  xyz: "https://rdap.centralnic.com/xyz/v1/domain/",
  io: "https://rdap.nic.io/domain/",
  ai: "https://rdap.identitydigital.services/rdap/domain/",
  dev: "https://rdap.nic.google/domain/",
  app: "https://rdap.nic.google/domain/",
};

/** Bootstrap fallback when TLD has no dedicated base. */
const RDAP_BOOTSTRAP = "https://rdap.org/domain/";

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
    if (res.status >= 400 && res.status < 500) {
      // 400-ish often means not registered on some RDAP servers
      if (res.status === 400 || res.status === 422) {
        return {
          domain,
          available: true,
          status: "AVAILABLE",
          source: "rdap",
          checkedAt,
          detail: `rdap ${res.status}`,
        };
      }
    }
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

export const DEFAULT_TLDS = [".com", ".xyz", ".ai", ".dev", ".io"] as const;
