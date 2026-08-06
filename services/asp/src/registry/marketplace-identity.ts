/**
 * Two numbers that are not interchangeable, stated once so they cannot be swapped.
 *
 * WHY THIS MODULE EXISTS
 *
 * Untch has an OKX marketplace ASP id and an ERC-8004 agent id. They are different registries, they
 * were issued by different systems, and they are four digits apart:
 *
 *   ASP #6086   — the marketplace listing this service updates
 *   agent #6047 — the ERC-8004 on-chain identity this service publishes in its registration card
 *
 * Relisting under 6047 would create a second, unrelated marketplace presence and orphan the real
 * one, which carries the sales count and the review state. Nothing structural stops that mistake:
 * both are plain integers appearing in adjacent documents, and the correct one is only correct
 * because somebody remembered which was which.
 *
 * So the relisting payload names an ASP id from here, `assertMarketplaceIdentity` refuses any payload
 * that carries the agent id in the ASP position, and CI runs that assertion. The confusion becomes a
 * failed build rather than a new listing.
 */

/** The existing OKX ASP. An update targets this and never creates a new one. */
export const OKX_ASP_ID = 6086 as const;

/** The ERC-8004 on-chain agent identity. Valid ONLY in that role, never as an ASP id. */
export const ERC8004_AGENT_ID = 6047 as const;

/** A2MCP is the transport every listed service is reached through. */
export const ASP_TYPE = "A2MCP" as const;

export const PRODUCTION_BASE_URL = "https://asp.untch.xyz" as const;
export const DOCS_URL = "https://docs.untch.xyz" as const;
export const SITE_URL = "https://untch.xyz" as const;

/**
 * Hosts a listing may name.
 *
 * A marketplace entry has to be reachable for as long as the listing exists, so a URL that outlives
 * neither a branch nor a laptop cannot appear in one. Preview deployments, tunnels and Railway's
 * generated subdomains all answer today and answer nothing next week; a reviewer following one
 * during a review window would find a service that had vanished.
 */
const ALLOWED_LISTING_HOSTS: readonly string[] = ["asp.untch.xyz", "docs.untch.xyz", "untch.xyz"];

/** Substrings that mark a URL as temporary regardless of which host it claims to be. */
const TEMPORARY_HOST_MARKERS: readonly string[] = [
  // These two are DENYLIST entries, not served URLs. They exist to refuse a listing that names them,
  // so removing them from this file would remove the check rather than satisfy it.
  "localhost", // production-surface-allow: localhost — a denylist entry that refuses this host, not one that serves it
  "127.0.0.1", // production-surface-allow: localhost — same: refused, never served
  "0.0.0.0",
  ".railway.app",
  ".up.railway.app",
  ".vercel.app",
  ".ngrok.io",
  ".ngrok-free.app",
  ".trycloudflare.com",
  ".loca.lt",
  ".onrender.com",
  ".herokuapp.com",
];

export interface IdentityViolation {
  readonly what: string;
  readonly detail: string;
}

/**
 * Every reason a payload must not be submitted, collected rather than thrown one at a time.
 *
 * All of them, because a caller fixing a listing wants the whole list. Reporting the first and
 * stopping turns one review into as many reviews as there are mistakes.
 */
export function marketplaceIdentityViolations(payload: {
  readonly aspId: unknown;
  readonly urls: readonly string[];
}): IdentityViolation[] {
  const out: IdentityViolation[] = [];

  if (payload.aspId !== OKX_ASP_ID) {
    out.push({
      what: "aspId",
      detail:
        `the listing targets ${String(payload.aspId)} and the existing ASP is ${OKX_ASP_ID}` +
        (payload.aspId === ERC8004_AGENT_ID
          ? ` — ${ERC8004_AGENT_ID} is the ERC-8004 agent id, and using it here would register a ` +
            "second marketplace presence instead of updating the real one"
          : ""),
    });
  }

  for (const url of payload.urls) {
    let host: string;
    try {
      const parsed = new URL(url);
      host = parsed.host.toLowerCase();
      if (parsed.protocol !== "https:") {
        out.push({ what: url, detail: `served over ${parsed.protocol.replace(":", "")}, and a listing must be https` });
        continue;
      }
    } catch {
      out.push({ what: url, detail: "is not a URL a reviewer could open" });
      continue;
    }
    const marker = TEMPORARY_HOST_MARKERS.find((m) => host.includes(m));
    if (marker) {
      out.push({ what: url, detail: `names ${marker}, which is a temporary host and will not outlive the review` });
      continue;
    }
    if (!ALLOWED_LISTING_HOSTS.includes(host)) {
      out.push({ what: url, detail: `names ${host}, which is not one of this project's stable production hosts` });
    }
  }

  return out;
}

/** Refuse a payload that names the wrong identity or an endpoint that will not outlive the review. */
export function assertMarketplaceIdentity(payload: {
  readonly aspId: unknown;
  readonly urls: readonly string[];
}): void {
  const violations = marketplaceIdentityViolations(payload);
  if (violations.length === 0) return;
  throw new Error(
    `the relisting payload must not be submitted:\n${violations.map((v) => `  ${v.what} — ${v.detail}`).join("\n")}`,
  );
}
