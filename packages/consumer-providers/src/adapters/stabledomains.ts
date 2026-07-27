/**
 * StableDomains — governed domain check, registration and renewal.
 *
 * Everything below is written against the LIVE OpenAPI and LIVE 402 challenges captured on
 * 2026-07-27 (internal/consumer-pack-evidence/), not against the research reports. Four facts from
 * that reading shape this adapter, and three of them contradict the reports:
 *
 *   1. Registration has a PREREQUISITE. `/api/register` requires a verified ICANN registrant profile
 *      (`POST /api/profile` → `POST /api/profile/verify-email` with a 6-digit emailed code), both
 *      SIWX-gated. `/api/check` reports this as `readyToRegister` + `profile.emailVerified`. A quote
 *      that ignored it would sell an approval for a purchase that cannot complete, so `quote()`
 *      surfaces it as a first-class term and `execute()` refuses without it.
 *
 *   2. `/api/check` costs $0.05 and `/api/search` costs $0.01. Discovery is not free; it is paid from
 *      the small discovery capability, never from the execution authority.
 *
 *   3. Pricing is DYNAMIC (`bondingMultiplier`, `dailySlotsRemaining`), so a price read at search
 *      time is not the price at registration time. The quote therefore takes its number from the
 *      register endpoint's OWN unpaid 402 probe, which is the exact atomic amount it will charge.
 *
 *   4. `/api/domain/verify` looks up the `_stabledomains` TXT attestation over PUBLIC DNS. That is a
 *      genuine independent delivery check — not the merchant telling us it worked — and it is what
 *      makes `untchVerified` meaningfully different from `providerAttested` for this provider.
 */

import {
  asset,
  hashQuote,
  money,
  newDiscoveryId,
  normalizedError,
  parseMoney,
  ProviderError,
  type DeliveryEvidence,
  type DiscoveryInput,
  type DiscoveryResult,
  type ExecuteInput,
  type PaymentCapability,
  type ProviderExecution,
  type ProviderQuote,
  type ProviderReference,
  type ProviderStatus,
  type QuoteInput,
} from "@untch/consumer-core";
import {
  BaseAdapter,
  type AdapterContext,
  type ProviderCapabilityDescriptor,
} from "../adapter";
import { arr, bool, dig, obj, optStr, str, validated } from "../schema";

export const STABLEDOMAINS_BASE_URL = "https://stabledomains.dev";

/** The 28 TLDs the live OpenAPI enumerates. A domain outside this set is refused before any spend. */
export const SUPPORTED_TLDS: readonly string[] = Object.freeze([
  ".ai", ".app", ".biz", ".cloud", ".co", ".com", ".dev", ".email", ".info", ".io", ".link",
  ".live", ".me", ".mobi", ".name", ".net", ".online", ".org", ".page", ".pro", ".shop", ".site",
  ".store", ".studio", ".tech", ".tv", ".uk", ".xyz",
]);

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "`domain` must be a string"));
  }
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(d) || d.length > 253) {
    throw new ProviderError(
      normalizedError("PROVIDER_BAD_REQUEST", "`domain` is not a valid hostname"),
    );
  }
  const tld = d.slice(d.lastIndexOf("."));
  if (!SUPPORTED_TLDS.includes(tld)) {
    throw new ProviderError(
      normalizedError(
        "PROVIDER_REJECTED",
        `TLD ${tld} is not one of the 28 StableDomains supports`,
      ),
    );
  }
  return d;
}

export class StableDomainsAdapter extends BaseAdapter {
  readonly providerId = "stabledomains";

  constructor(baseUrl: string = STABLEDOMAINS_BASE_URL) {
    super(baseUrl);
  }

  capabilities(): readonly ProviderCapabilityDescriptor[] {
    return [
      { capability: "domains.check", description: "availability + live price for one domain", movesValue: false },
      { capability: "domains.quote", description: "bindable registration quote", movesValue: false },
      { capability: "domains.register", description: "register a domain", movesValue: true },
      { capability: "domains.renew", description: "renew a domain for 1-10 years", movesValue: true },
      { capability: "domains.dns", description: "read/change DNS (SIWX-gated)", movesValue: false },
    ];
  }

  protected override healthPath(): string {
    return "/.well-known/x402";
  }

  /** POST /api/search — $0.01. One name across every supported TLD, availability only (no prices). */
  async discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult> {
    const name = str(input.params.name ?? input.params.query, "params.name", 64)
      .toLowerCase()
      .replace(/\..*$/, "")
      .replace(/[^a-z0-9-]/g, "");
    if (name === "") {
      throw new ProviderError(normalizedError("PROVIDER_BAD_REQUEST", "`name` is required"));
    }

    const result = await this.paid(
      {
        method: "POST",
        path: "/api/search",
        body: { name },
        ...(ctx.discoveryPayment ? { payment: ctx.discoveryPayment } : {}),
      },
      ctx,
    );

    const body = validated("StableDomains /api/search", () => obj(result.json, "search"));
    const rows = validated("StableDomains /api/search results", () =>
      arr(body.results ?? [], "search.results").map((r, i) => {
        const o = obj(r, `search.results[${i}]`);
        return {
          domain: str(o.domain, `search.results[${i}].domain`, 253),
          available: bool(o.available, `search.results[${i}].available`),
          premium: bool(o.premium, `search.results[${i}].premium`),
          tld: str(o.tld, `search.results[${i}].tld`, 16),
        };
      }),
    );

    return {
      providerId: this.providerId,
      discoveryId: newDiscoveryId(),
      // Availability only — the provider does not price a search, and inventing an indicative price
      // would put a number in front of a user that nothing stands behind.
      options: rows
        .filter((r) => r.available)
        .slice(0, input.limit)
        .map((r) => ({
          providerRef: r.domain,
          title: r.domain,
          description: r.premium ? "available (premium pricing)" : "available",
          indicativePrice: null,
          imageUrl: null,
          attributes: { tld: r.tld, premium: r.premium, available: true },
        })),
      truncated: rows.length > input.limit,
      retrievedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * A bindable quote.
   *
   * Two calls, for two different reasons:
   *   • `/api/check` ($0.05) answers "is it available, and is this wallet allowed to register it" —
   *     the registrant-profile prerequisite that would otherwise fail after the money moved.
   *   • an unpaid 402 probe of `/api/register` answers "exactly what will you charge" — the
   *     provider's own atomic figure, on its own rail, to its own payTo.
   */
  async quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    const domain = normalizeDomain(input.providerRef || input.params.domain);
    const action = input.action;
    const isRenew = action === "domains.renew";

    let readyToRegister = true;
    let profileNote = "";
    let premium = false;

    if (!isRenew) {
      const checked = await this.paid(
        {
          method: "POST",
          path: "/api/check",
          body: { domain },
          ...(ctx.discoveryPayment ? { payment: ctx.discoveryPayment } : {}),
        },
        ctx,
      );
      const body = validated("StableDomains /api/check", () => obj(checked.json, "check"));
      const available = bool(body.available, "check.available");
      if (!available) {
        throw new ProviderError(
          normalizedError("PROVIDER_REJECTED", `${domain} is not available for registration`),
        );
      }
      premium = bool(body.premium ?? false, "check.premium");
      readyToRegister = body.readyToRegister === undefined ? false : bool(body.readyToRegister, "check.readyToRegister");
      const emailVerified = dig(body.profile, "emailVerified");
      profileNote = readyToRegister
        ? "registrant profile verified"
        : emailVerified === false
          ? "registrant profile exists but its email is NOT verified (POST /api/profile/verify-email)"
          : "no ICANN registrant profile on file for the paying wallet (POST /api/profile)";
    }

    // The provider's own price, from its own challenge.
    const path = isRenew ? "/api/domain/renew" : "/api/register";
    const body = isRenew ? { domain, count: readRenewCount(input.params) } : { domain };
    const priced = await this.probe402("POST", path, ctx, body);

    return {
      providerId: this.providerId,
      providerRef: domain,
      cost: priced.amount,
      settlementRecipient: priced.recipient,
      settlementChain: priced.option.network,
      settlementAsset: priced.asset,
      summary: isRenew ? `Renew ${domain}` : `Register ${domain}`,
      terms: {
        domain,
        action,
        premium,
        readyToRegister,
        profileNote,
        // Recorded verbatim so the receipt shows what the merchant actually promised, and so a
        // dispute has the merchant's own words rather than our paraphrase.
        supportedTlds: SUPPORTED_TLDS.length,
        ...(isRenew ? { years: readRenewCount(input.params) } : {}),
      },
      expiresAt: new Date((ctx.clock?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  /**
   * POST /api/register (or /api/domain/renew).
   *
   * The prerequisite is re-checked here, not just at quote time: a quote can be minutes old, and
   * spending $20 on a registration that the provider will refuse for a missing profile is exactly the
   * kind of avoidable manual review this gate prevents.
   */
  async execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution> {
    const domain = normalizeDomain(input.providerRef);
    const isRenew = input.action === "domains.renew";

    if (!isRenew && input.quote.terms.readyToRegister !== true) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_UNAUTHORIZED",
          `refusing to pay for ${domain}: ${String(input.quote.terms.profileNote ?? "the paying wallet has no verified ICANN registrant profile")}. ` +
            "StableDomains requires a verified registrant profile before /api/register will succeed, " +
            "so paying first would spend real funds on a call that cannot complete.",
        ),
      );
    }

    const path = isRenew ? "/api/domain/renew" : "/api/register";
    const body = isRenew
      ? { domain, count: readRenewCount(input.params) }
      : { domain };

    const result = await this.paid(
      {
        method: "POST",
        path,
        body,
        payment,
        allowedRecipients: [input.quote.settlementRecipient],
        ceilingFor: () => input.quote.cost,
        // The provider takes no idempotency key of its own; the guard against a double registration
        // is `consumer_provider_executions UNIQUE (provider_id, idempotency_key)` plus the
        // single-use capability, both of which are enforced before this method is entered.
        headers: { "x-untch-request-id": input.idempotencyKey },
      },
      ctx,
    );

    if (result.response.status >= 400) {
      throw this.classifyStatus(result.response, `${this.providerId} ${path}`);
    }
    if (!result.settlement) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_MALFORMED_RESPONSE",
          `${path} returned ${result.response.status} without ever demanding payment — refusing to ` +
            "record a settlement that did not happen",
        ),
      );
    }

    const parsed = validated(`StableDomains ${path}`, () => {
      const o = obj(result.json, "register");
      return {
        domain: str(o.domain, "register.domain", 253),
        status: str(o.status ?? "pending", "register.status", 64),
        orderId: optStr(o.orderId, "register.orderId", 128),
        jobId: optStr(o.jobId, "register.jobId", 128),
        newExpiresAt: optStr(o.newExpiresAt, "renew.newExpiresAt", 64),
        registrationEmailSent:
          o.registrationEmailSent === undefined ? null : bool(o.registrationEmailSent, "register.registrationEmailSent"),
      };
    });

    return {
      providerReference: parsed.orderId ?? parsed.jobId ?? parsed.domain,
      settlement: {
        txHash: result.settlement.txHash,
        chain: result.settlement.chain,
        amount: result.settlement.amount,
        recipient: result.settlement.recipient,
      },
      providerStatus: parsed.status,
      payload: {
        domain: parsed.domain,
        status: parsed.status,
        orderId: parsed.orderId,
        jobId: parsed.jobId,
        newExpiresAt: parsed.newExpiresAt,
        registrationEmailSent: parsed.registrationEmailSent,
      },
      acknowledgedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /** GET /api/domain/status?domain= — free. */
  async getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus> {
    const domain = normalizeDomain(ref.reference);
    const res = await this.raw(
      "GET",
      `/api/domain/status?domain=${encodeURIComponent(domain)}`,
      ctx,
      {},
    );
    if (res.status >= 400) throw this.classifyStatus(res, `${this.providerId} /api/domain/status`);
    const body = validated("StableDomains /api/domain/status", () => obj(safeJson(res.text), "status"));
    const raw = str(body.status ?? "unknown", "status.status", 64).toLowerCase();
    return {
      reference: domain,
      state:
        raw === "active"
          ? "FULFILLED"
          : raw === "pending"
            ? "IN_PROGRESS"
            : raw === "failed"
              ? "FAILED"
              : "UNKNOWN",
      detail: raw,
      raw: body,
      checkedAt: new Date(ctx.clock?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * GET /api/domain/verify?domain= — free, and genuinely independent: it reads the `_stabledomains`
   * TXT attestation over PUBLIC DNS. That is why `untchVerified.verified` here means something the
   * merchant cannot simply assert.
   */
  async verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence> {
    const domain = str(exec.payload.domain, "execution.payload.domain", 253);
    const attested = {
      status: exec.providerStatus,
      reference: exec.providerReference,
      attestedAt: exec.acknowledgedAt,
      fields: exec.payload,
    };

    let verified = false;
    let detail = "";
    let raw: unknown = null;
    try {
      const res = await this.raw(
        "GET",
        `/api/domain/verify?domain=${encodeURIComponent(domain)}`,
        ctx,
        {},
      );
      raw = safeJson(res.text);
      if (res.status < 400) {
        const body = obj(raw, "verify");
        // The endpoint reports whether a public DNS TXT attestation exists for the domain. Accept
        // only an explicit positive; anything else is "not yet proven", never "probably fine".
        const flag = body.verified ?? body.found ?? body.attested;
        verified = flag === true;
        detail = verified
          ? `_stabledomains TXT attestation resolves for ${domain}`
          : `no _stabledomains TXT attestation for ${domain} yet`;
      } else {
        detail = `verify endpoint returned ${res.status}`;
      }
    } catch (err) {
      detail = `verification could not be performed: ${this.normalizeError(err).message}`;
    }

    return {
      intentId: "",
      providerId: this.providerId,
      providerAttested: attested,
      untchVerified: {
        verified,
        method: "DNS_LOOKUP",
        detail,
        verifiedAt: verified ? new Date(ctx.clock?.() ?? Date.now()).toISOString() : null,
      },
      evidenceHash: hashQuote({ attested, verified, detail, raw }),
    };
  }
}

function readRenewCount(params: Readonly<Record<string, unknown>>): number {
  const raw = params.count ?? params.years ?? 1;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10) {
    throw new ProviderError(
      normalizedError("PROVIDER_BAD_REQUEST", "`count` must be an integer between 1 and 10 years"),
    );
  }
  return n;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

/**
 * Exported so the registry seed and the tests share one definition of what this adapter costs to
 * read from. These are the LIVE prices observed on 2026-07-27, not a guess.
 */
export const STABLEDOMAINS_DISCOVERY_COSTS = Object.freeze({
  search: parseMoney("0.01", asset("base.usdc")),
  check: parseMoney("0.05", asset("base.usdc")),
});

/** The verified Base payTo, read from the live challenges. Used to seed the recipient allowlist. */
export const STABLEDOMAINS_BASE_PAYTO = "0xABcb091D90419E1c8AD4818f1B33FC4645501892";

/** A zero of the settlement asset, for callers that need a typed default. */
export const STABLEDOMAINS_SETTLEMENT_ZERO = money(0n, asset("base.usdc"));
