/**
 * The provider registry seed.
 *
 * This file is the single place where a provider's maturity is asserted, and every `provenance`
 * string below is a factual statement about a request that was actually made on 2026-07-27. The raw
 * evidence is committed under internal/consumer-pack-evidence/ and can be re-fetched with
 * `probe-discovery.mjs` / `probe-paid-endpoints.mjs`.
 *
 * NOTHING here is `verified`, and that is not an oversight. The seed INTRODUCES a provider; it never
 * re-asserts its status (see the wiring's comment on why an unconditional upsert was a live control
 * failure in both directions). Promotion to `verified` happens once, against a real settled payment
 * plus a verified delivery, and lands on the DURABLE row — which is why a provider can read
 * `verified` in production while this file still says `sandbox`. That divergence is the mechanism
 * working, not drift.
 *
 * `accessBlocker` answers a different question from `maturity`. Maturity says "may this execute?";
 * the blocker says "whose problem is it?" — and only appears when the answer is genuinely not ours.
 *
 * Read the maturity column as: "what is the weakest link in this integration?"
 */

import {
  BASE_MAINNET,
  SOLANA_MAINNET,
  type ProviderCapabilityRecord,
  type ProviderRecord,
} from "@untch/consumer-core";
import { PURCH_BASE_URL } from "./adapters/purch";
import { STABLEDOMAINS_BASE_URL } from "./adapters/stabledomains";
import { STABLEEMAIL_BASE_URL } from "./adapters/stableemail";
import { STABLEMERCH_BASE_URL } from "./adapters/stablemerch";
import { STABLETRAVEL_BASE_URL } from "./adapters/stabletravel";

export interface ProviderSeed {
  readonly provider: ProviderRecord;
  readonly capabilities: readonly ProviderCapabilityRecord[];
}

export const PROVIDER_SEEDS: readonly ProviderSeed[] = Object.freeze([
  {
    provider: {
      providerId: "stabledomains",
      displayName: "StableDomains",
      maturity: "sandbox",
      baseUrl: STABLEDOMAINS_BASE_URL,
      protocol: "x402",
      chains: [BASE_MAINNET, SOLANA_MAINNET],
      provenance:
        "2026-07-27: POST /api/search, /api/check, /api/register and /api/domain/renew each returned a " +
        "402 with a populated accepts[] offering Base USDC (0x8335…2913, payTo 0xABcb…1892, EIP-3009 " +
        "domain {name:'USD Coin',version:'2'}) and Solana USDC. Live prices read from those challenges: " +
        "search $0.01, check $0.05, register $20.00, renew $20.00. Full OpenAPI (14 paths) and " +
        ".well-known/x402 both fetched. SANDBOX, not verified: no settlement has ever been made from an " +
        "Untch treasury wallet, because no Base treasury key is configured.",
      enabled: true,
    },
    capabilities: [
      {
        providerId: "stabledomains",
        capability: "domains.check",
        maturity: "sandbox",
        notes: "POST /api/check, $0.05, Base USDC. Returns availability, currentPrice and readyToRegister.",
      },
      {
        providerId: "stabledomains",
        capability: "domains.quote",
        maturity: "sandbox",
        notes: "check + an unpaid 402 probe of /api/register for the exact atomic price.",
      },
      {
        providerId: "stabledomains",
        capability: "domains.register",
        maturity: "sandbox",
        notes:
          "POST /api/register, dynamic price. PREREQUISITE: a verified ICANN registrant profile, " +
          "created and email-verified over SIWX. execute() refuses without it rather than spending first.",
      },
      {
        providerId: "stabledomains",
        capability: "domains.renew",
        maturity: "sandbox",
        notes: "POST /api/domain/renew, 1-10 years, dynamic price.",
      },
      {
        providerId: "stabledomains",
        capability: "domains.dns",
        maturity: "experimental",
        notes:
          "SIWX-gated (402 with an empty accepts[] plus a sign-in-with-x extension). The SIWX leg has " +
          "never been exercised against the live service, so the EIP-4361 rendering this build produces " +
          "is unproven.",
      },
    ],
  },

  {
    provider: {
      providerId: "stableemail",
      displayName: "StableEmail",
      maturity: "sandbox",
      baseUrl: STABLEEMAIL_BASE_URL,
      protocol: "x402",
      chains: [BASE_MAINNET, SOLANA_MAINNET],
      provenance:
        "2026-07-29: every endpoint below re-probed live and its price read from the merchant's own " +
        "402. Base USDC (0x8335…2913, payTo 0xdb5a…0671), Solana USDC (payTo HvBMG7ez…2XEY) and a " +
        "Tempo MPP charge offer appear on every paid route. Prices observed, in atomic USDC: " +
        "/api/send 20000, /api/inbox/buy 1000000, /api/inbox/topup 1000000 (quarter 2500000, year " +
        "8000000), /api/subdomain/buy 5000000, /api/subdomain/send 5000. The status and cancel " +
        "routes answer a 402 with an EMPTY accepts[] plus a sign-in-with-x extension " +
        "(eip155:8453/eip191) — SIWX authentication, not payment.",
      enabled: true,
    },
    capabilities: [
      { providerId: "stableemail", capability: "notify.confirmation", maturity: "sandbox", notes: "POST /api/send, $0.02." },
      { providerId: "stableemail", capability: "notify.receipt", maturity: "sandbox", notes: "POST /api/send, $0.02." },
      { providerId: "stableemail", capability: "notify.exception", maturity: "sandbox", notes: "POST /api/send, $0.02." },

      // ── Untch Mail ────────────────────────────────────────────────────────
      //
      // Per-tool, because the tools are not equally proven. `mail.send` is one unauthenticated paid
      // call; `mail.subdomain.send` additionally requires the paying wallet to OWN the subdomain it
      // sends from. Reporting one maturity for the family would overstate the second or understate
      // the first.
      {
        providerId: "stableemail",
        capability: "mail.send",
        maturity: "sandbox",
        notes:
          "POST /api/send, $0.02 (20000 atomic USDC), Base + Solana + Tempo. No settlement from an " +
          "Untch treasury wallet yet. Delivery is provider-attested only — the shared relay exposes " +
          "no per-message status endpoint.",
      },
      {
        providerId: "stableemail",
        capability: "mail.inbox.buy",
        maturity: "sandbox",
        notes:
          "POST /api/inbox/buy, $1.00 (1000000 atomic USDC) for 30 days. Delivery IS independently " +
          "verifiable here: the purchased inbox is polled back over /api/inbox/status.",
      },
      {
        providerId: "stableemail",
        capability: "mail.inbox.topup",
        maturity: "sandbox",
        notes:
          "POST /api/inbox/topup $1.00 / …/quarter $2.50 / …/year $8.00. Anyone may top up any " +
          "inbox — no SIWX — so this is payable without owning the inbox.",
      },
      {
        providerId: "stableemail",
        capability: "mail.inbox.status",
        maturity: "experimental",
        accessBlocker: "IDENTITY_REQUIRED",
        notes:
          "GET /api/inbox/status, free but SIWX-gated. StableEmail authorises it by owner SIGNATURE, " +
          "and Untch's inbox is owned by the wallet that PAID for it — the Base settlement treasury. " +
          "Satisfying this would mean handing the SIWX identity the treasury's key, collapsing a " +
          "powerless identity key into a spending key so that a leaked signer could drain the float. " +
          "Untch will not make that trade for a status field, so this stays blocked BY CHOICE. " +
          "mail.inbox.messages reads the same inbox by PAYER instead, which the treasury already is.",
      },
      {
        providerId: "stableemail",
        capability: "mail.inbox.messages",
        maturity: "sandbox",
        notes:
          "POST /api/inbox/messages, $0.001 (1000 atomic USDC), authorised by PAYER-as-owner rather " +
          "than by signature — which is why it works where mail.inbox.status cannot. Runs on the " +
          "small discovery capability. Returns hashes only: the provider cannot tell one Untch " +
          "caller from another, so raw senders and subjects would let any caller read the " +
          "operational mailbox by naming it.",
      },
      {
        providerId: "stableemail",
        capability: "mail.inbox.cancel",
        maturity: "experimental",
        accessBlocker: "IDENTITY_REQUIRED",
        notes:
          "POST /api/inbox/cancel, free, SIWX-gated, owner-only. Sends a pro-rata USDC refund " +
          "on-chain to the caller's wallet. Same prerequisite as mail.inbox.status.",
      },
      {
        providerId: "stableemail",
        capability: "mail.subdomain.buy",
        maturity: "sandbox",
        notes:
          "POST /api/subdomain/buy, $5.00 (5000000 atomic USDC). DNS verification takes ~5 minutes, " +
          "so the purchase completes IN_PROGRESS and only reaches FULFILLED once DNS and SES both " +
          "verify.",
      },
      {
        providerId: "stableemail",
        capability: "mail.subdomain.status",
        maturity: "experimental",
        accessBlocker: "IDENTITY_REQUIRED",
        notes:
          "GET /api/subdomain/status, free, SIWX-gated, owner-or-signer only. Prerequisite is " +
          "mail.subdomain.buy.",
      },
      {
        providerId: "stableemail",
        capability: "mail.subdomain.send",
        maturity: "experimental",
        accessBlocker: "IDENTITY_REQUIRED",
        notes:
          "POST /api/subdomain/send, $0.005 (5000 atomic USDC). The PAYING wallet must be the " +
          "subdomain owner or an authorised signer, so paying is necessary and not sufficient.",
      },
    ],
  },

  {
    provider: {
      providerId: "stabletravel",
      displayName: "StableTravel",
      maturity: "sandbox",
      baseUrl: STABLETRAVEL_BASE_URL,
      protocol: "x402",
      chains: [BASE_MAINNET, SOLANA_MAINNET],
      provenance:
        "2026-07-27: OpenAPI fetched — 45 paths, zero booking paths. Its own x-guidance states the API " +
        "'does not issue tickets, hold reservations, or take payment for travel' and that there are 'no " +
        "hotel, activity, or ground-transfer endpoints'. This CONTRADICTS deep-research-report (4).md, " +
        "which described 74 endpoints with end-to-end booking and cancellation. Registered as a flight " +
        "DATA provider only: it declares no travel.quote or travel.book capability, so the registry " +
        "cannot route a booking to it.",
      enabled: true,
    },
    capabilities: [
      {
        providerId: "stabletravel",
        capability: "travel.search",
        maturity: "sandbox",
        notes: "GET /api/google-flights/search, $0.02. Live cash fares with price_insights.",
      },
      {
        providerId: "stabletravel",
        capability: "travel.compare",
        maturity: "sandbox",
        notes: "GET /api/google-flights/booking, $0.02. Airline and OTA booking links for one itinerary.",
      },
    ],
  },

  {
    provider: {
      providerId: "purch",
      displayName: "Purch",
      /**
       * VERIFIED at the provider level, which is a statement about evidence rather than about scope.
       *
       * It records that at least one capability under this provider has completed a real settled
       * payment and a real delivery. It does NOT mean every capability has. The registry takes the
       * LOWER of provider and capability maturity, so each capability row stays the final execution
       * boundary and the three experimental ones below remain unexecutable.
       */
      maturity: "verified",
      baseUrl: PURCH_BASE_URL,
      protocol: "x402",
      chains: [SOLANA_MAINNET],
      provenance:
        "2026-07-27: /x402/search, /x402/shop, /x402/vault/search and /x402/vault/download all returned " +
        "402s offering exactly ONE option, on solana:5eykt4Us… in USDC (mint EPjFWd…Dt1v, payTo " +
        "8LiXrHC6…6HT2, sponsoring feePayer BENrLoUb…R9SP). NO Base option appears in any Purch " +
        "challenge, and its OpenAPI states 'All endpoints are payable via the x402 protocol (USDC on " +
        "Solana).' 2026-07-29: the Solana rail settled. x402 v2 payload construction works, the " +
        "PAYMENT-SIGNATURE header is accepted, 0.010000 USDC settled from an Untch treasury, and Purch " +
        "returned five real Shopify products. shop.search is verified on that payment and delivery " +
        "evidence. The full ConsumerOrchestrator lifecycle is awaiting its bounded production proof, " +
        "and continuous Solana execution stays disabled until a persistent signer arrangement is " +
        "approved.",
      enabled: true,
    },
    capabilities: [
      {
        providerId: "purch",
        capability: "shop.search",
        /**
         * The only Purch capability with settlement AND delivery evidence behind it.
         *
         * Promoted on 2026-07-29 after 0.010000 USDC settled on Solana from an Untch treasury and the
         * call returned five real Shopify products. For a paid search the returned product set IS the
         * delivered service, so both halves of the verified definition are met.
         */
        maturity: "verified",
        /**
         * A PAID READ, and saying so is what makes the full lifecycle reachable.
         *
         * The 2026-07-29 settlement that earned `verified` went through `discover()`, which pays the
         * search endpoint directly. Nothing had ever driven this capability through
         * quote-policy-reserve-execute, and when the first production proof did, it failed: the adapter's
         * only quote path demanded a shipping address and an email because it was written for
         * `/x402/buy`. A search has neither. This field is what routes it to the search endpoint instead.
         */
        executionShape: "PAID_READ",
        notes:
          "GET /x402/search, $0.01, Solana only. Settled and delivered. Public state stays BETA " +
          "rather than LIVE because execution needs an operator arming sequence: the treasury signer " +
          "is removed after each bounded run.",
      },
      {
        providerId: "purch",
        capability: "shop.quote",
        maturity: "experimental",
        executionShape: "FULFILMENT",
        notes: "Unpaid 402 probe of /x402/buy (pricingMode 'quote' — total includes tax and shipping).",
      },
      {
        providerId: "purch",
        capability: "shop.purchase",
        maturity: "experimental",
        executionShape: "FULFILMENT",
        notes: "POST /x402/buy, dynamic total, Solana only. No settlement or delivery evidence yet, so it stays " +
          "experimental and cannot execute even though the provider is verified.",
      },
      {
        providerId: "purch",
        capability: "shop.track",
        maturity: "experimental",
        /**
         * Declared FULFILMENT even though tracking is, by nature, a paid read.
         *
         * `GET /x402/track` has nothing to ship and would fit PAID_READ perfectly — but the adapter's
         * paid-read quote path only knows how to price a SEARCH, and declaring a shape the adapter cannot
         * serve would be a claim with no implementation behind it. The maturity floor refuses this
         * capability long before a quote is attempted, so the declared shape is unreachable either way;
         * the honest value is the one that matches what the code can actually do. It becomes PAID_READ in
         * the same change that implements its quote.
         */
        executionShape: "FULFILMENT",
        notes: "GET /x402/track, $0.52 per call, Solana only. The endpoint exists in the live 402 surface. No " +
          "settlement or delivery evidence yet, so it stays experimental and cannot execute.",
      },
    ],
  },

  {
    provider: {
      providerId: "stablemerch",
      displayName: "StableMerch",
      maturity: "experimental",
      baseUrl: STABLEMERCH_BASE_URL,
      protocol: "siwx",
      chains: [BASE_MAINNET, SOLANA_MAINNET],
      provenance:
        "2026-07-27: GET /api/catalog and POST /api/drafts both returned a 402 with an EMPTY accepts[] " +
        "plus a sign-in-with-x extension (eip155:8453/eip191 or solana/ed25519) — i.e. SIWX " +
        "authentication, NOT payment. Its OpenAPI declares securitySchemes.siwx as a SIGN-IN-WITH-X " +
        "header and marks /api/drafts security:[{siwx:[]}]. Only /api/drafts/{id}/commit carries " +
        "x-payment-info (dynamic $0.01-$50.00, x402 + MPP). EXPERIMENTAL: four of the five steps need a " +
        "wallet identity, CONSUMER_SIWX_PRIVATE_KEY is unset here, and the EIP-4361 rendering this build " +
        "produces has never been accepted by StableMerch's verifier.",
      enabled: true,
    },
    capabilities: [
      {
        providerId: "stablemerch",
        capability: "gifts.quote",
        maturity: "experimental",
        notes: "SIWX draft → prepare-order → unpaid 402 probe of commit.",
      },
      {
        providerId: "stablemerch",
        capability: "gifts.order",
        maturity: "experimental",
        notes: "POST /api/drafts/{id}/commit, dynamic $0.01-$50.00.",
      },
      {
        providerId: "stablemerch",
        capability: "gifts.track",
        maturity: "experimental",
        notes: "GET /api/drafts/{id}, SIWX-gated.",
      },
    ],
  },
]);

/** Every capability any seeded provider declares — what the ASP's routes can possibly resolve. */
export function seededCapabilities(): readonly string[] {
  const out = new Set<string>();
  for (const seed of PROVIDER_SEEDS) {
    for (const cap of seed.capabilities) out.add(cap.capability);
  }
  return [...out].sort();
}
