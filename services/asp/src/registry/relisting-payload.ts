import { SERVICES, serviceById } from "./services";
import { buildListingPayload, threePartDescription } from "./listing";
import {
  ASP_TYPE,
  DOCS_URL,
  ERC8004_AGENT_ID,
  OKX_ASP_ID,
  PRODUCTION_BASE_URL,
  SITE_URL,
  assertMarketplaceIdentity,
} from "./marketplace-identity";

/**
 * The exact payload that updates the EXISTING ASP #6086, generated rather than typed.
 *
 * WHY IT IS GENERATED
 *
 * The submission that got two services rejected was a markdown table pasted into a chat window. The
 * table was written by hand from a reading of the code, and by the time it was submitted the code had
 * moved: the listing said a service needed three things and the validator demanded seventeen. Nothing
 * compared the two, because one of them was prose.
 *
 * Every field below comes from the registry the running service is built from, so the payload cannot
 * describe a service this host does not serve, at a price it does not charge, on a chain it does not
 * settle on.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not submit. Producing the payload and sending it are separate acts on purpose — the whole
 * failure being corrected is a submission that nobody could check before it went out.
 */

/**
 * The product description, fixed copy rather than a generated sentence.
 *
 * The service descriptions are generated because they must track their contracts. This one is about
 * what Untch IS, which no schema can derive, so it is written once and pinned by a test — the test
 * checks the load-bearing claims are present, not the exact wording, so ordinary copy edits do not
 * fail a build.
 */
export const CONCISE_DESCRIPTION =
  "A live control plane for agent money. The model never touches the money.";

export const COMPLETE_DESCRIPTION = [
  "Untch is a live control plane for agent money. Agents submit exact commercial intents.",
  "Deterministic policy automatically approves, blocks or escalates them. Humans retain account and",
  "wallet authority. Approved requests create bounded reserved authority rather than broad wallet access.",
].join(" ");

/** What the listing may state, because each line is something a listed service actually does. */
export const CAPABILITIES: readonly string[] = Object.freeze([
  "deterministic policy evaluation",
  "automatic approval, blocking and escalation",
  "per-call and daily budgets",
  "provider and capability controls",
  "duplicate and replay protection",
  "exact quote binding",
  "paid x402 control services",
  "human approval through live supported channels",
  "reserved authority accounting",
  "quote lineage and atomic supersession",
  "decision and payment evidence",
]);

export interface RelistingService {
  readonly toolId: string;
  readonly name: string;
  readonly method: string;
  readonly endpoint: string;
  readonly protocol: string;
  readonly paid: boolean;
  /** `$0.05`, or null when free. The number a caller is actually charged. */
  readonly price: string | null;
  /** The same amount in USDT0 base units, so a reviewer never has to convert. */
  readonly amountBaseUnits: string | null;
  readonly description: string;
  readonly inputSchemaUrl: string;
  readonly outputSummary: string;
  readonly schemaVersion: string;
}

export interface RelistingPayload {
  /** The EXISTING ASP. This is an update, and there is no branch here that creates a new one. */
  readonly aspId: number;
  readonly aspType: typeof ASP_TYPE;
  readonly name: string;
  readonly conciseDescription: string;
  readonly completeDescription: string;
  readonly capabilities: readonly string[];
  readonly productionUrl: string;
  readonly docsUrl: string;
  readonly siteUrl: string;
  readonly profilePicture: { readonly url: string; readonly width: number; readonly height: number; readonly mimeType: string };
  readonly network: string;
  readonly settlementToken: { readonly symbol: string; readonly address: string; readonly decimals: number };
  readonly payTo: string;
  readonly paymentSdk: { readonly middleware: string; readonly version: string; readonly scheme: string };
  /**
   * The ERC-8004 identity, published beside the ASP id and clearly labelled.
   *
   * Included rather than omitted because a reviewer checking the on-chain identity needs it, and
   * labelling it here is what stops it being mistaken for the ASP id it sits next to.
   */
  readonly erc8004: { readonly agentId: number; readonly role: string };
  readonly approvalChannels: readonly { readonly channel: string; readonly status: string }[];
  readonly services: readonly RelistingService[];
}

/** What a caller receives, from the contract rather than from a summary of it. */
function outputSummary(toolId: string): string {
  const service = serviceById(toolId)!;
  return service.delivers;
}

export function buildRelistingPayload(args: {
  readonly payTo: string;
  readonly profilePictureUrl: string;
  readonly sdkVersion: string;
  readonly approvalChannels: readonly { readonly channel: string; readonly status: string }[];
}): RelistingPayload {
  const listing = buildListingPayload({
    baseUrl: PRODUCTION_BASE_URL,
    network: "eip155:196",
    name: "Untch",
  });

  const services: RelistingService[] = listing.service.map((entry) => {
    const service = serviceById(entry.toolId)!;
    return {
      toolId: service.toolId,
      name: service.publicName,
      method: service.method,
      endpoint: `${PRODUCTION_BASE_URL}${service.path}`,
      protocol: service.protocol,
      paid: service.pricing.kind === "paid",
      price: service.pricing.price,
      amountBaseUnits: service.pricing.amountBaseUnits,
      description: threePartDescription(service).text,
      inputSchemaUrl: `${PRODUCTION_BASE_URL}/schema/${service.toolId}`,
      outputSummary: outputSummary(service.toolId),
      schemaVersion: service.schemaVersion,
    };
  });

  const payload: RelistingPayload = {
    aspId: OKX_ASP_ID,
    aspType: ASP_TYPE,
    name: "Untch",
    conciseDescription: CONCISE_DESCRIPTION,
    completeDescription: COMPLETE_DESCRIPTION,
    capabilities: CAPABILITIES,
    productionUrl: PRODUCTION_BASE_URL,
    docsUrl: DOCS_URL,
    siteUrl: SITE_URL,
    profilePicture: { url: args.profilePictureUrl, width: 1024, height: 1024, mimeType: "image/png" },
    network: "eip155:196",
    settlementToken: {
      symbol: "USDT0",
      address: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      decimals: 6,
    },
    payTo: args.payTo,
    paymentSdk: { middleware: "@okxweb3/x402-express", version: args.sdkVersion, scheme: "exact" },
    erc8004: { agentId: ERC8004_AGENT_ID, role: "ERC-8004 on-chain agent identity — never the ASP id" },
    approvalChannels: args.approvalChannels,
    services,
  };

  /**
   * The identity check runs at BUILD time, not at submit time.
   *
   * A payload that names the wrong id or a temporary endpoint should not exist as a file somebody
   * could later paste into a chat window. Refusing to produce it is stronger than refusing to send it.
   */
  assertMarketplaceIdentity({
    aspId: payload.aspId,
    urls: [
      payload.productionUrl,
      payload.docsUrl,
      payload.siteUrl,
      ...payload.services.map((s) => s.endpoint),
      ...payload.services.map((s) => s.inputSchemaUrl),
    ],
  });

  return payload;
}

/** The human-readable table, for a reviewer who wants to read rather than parse. */
export function relistingServiceTable(payload: RelistingPayload): string {
  const rows = payload.services.map((s) => {
    const price = s.paid ? `${s.price} (${s.amountBaseUnits} base units)` : "free";
    return `| ${s.name} | ${s.method} | ${s.endpoint.replace(PRODUCTION_BASE_URL, "")} | ${price} | ${s.outputSummary} |`;
  });
  return [
    "| Service | Method | Endpoint | Price | What the caller receives |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export interface ListingDiff {
  readonly removed: readonly { readonly toolId: string; readonly reason: string }[];
  readonly priceChanges: readonly { readonly toolId: string; readonly from: string; readonly to: string }[];
  readonly kept: readonly string[];
  readonly added: readonly string[];
}

/**
 * What changes against a previously published listing.
 *
 * Takes the OLD entries as an argument rather than reading them from a file, because the thing being
 * diffed against is what the MARKETPLACE currently stores, and only a live read of the platform
 * knows that. A diff against a stale local copy would describe a change nobody is making.
 */
export function diffAgainstStoredListing(
  payload: RelistingPayload,
  stored: readonly { readonly toolId: string; readonly price: string | null }[],
): ListingDiff {
  const now = new Map(payload.services.map((s) => [s.toolId, s]));
  const before = new Map(stored.map((s) => [s.toolId, s]));

  const removed = stored
    .filter((s) => !now.has(s.toolId))
    .map((s) => {
      const service = serviceById(s.toolId);
      return {
        toolId: s.toolId,
        reason: service
          ? `classified ${service.classification.serviceClass}: ${service.classification.reason}`
          : "no longer a registered service on this host",
      };
    });

  const priceChanges = payload.services
    .filter((s) => before.has(s.toolId))
    .map((s) => ({ toolId: s.toolId, from: before.get(s.toolId)!.price ?? "free", to: s.price ?? "free" }))
    .filter((c) => c.from !== c.to);

  return {
    removed,
    priceChanges,
    kept: payload.services.filter((s) => before.has(s.toolId)).map((s) => s.toolId),
    added: payload.services.filter((s) => !before.has(s.toolId)).map((s) => s.toolId),
  };
}

/**
 * The instruction that updates the existing ASP.
 *
 * Written out rather than left to be composed at submission time, because "update 6086" and
 * "register a new ASP" are one careless sentence apart, and the careless sentence is the one that
 * orphans a listing carrying six sales and a review state.
 */
export const RELISTING_INSTRUCTION = [
  "Use Onchain OS and my logged-in Agentic Wallet to update and relist the existing A2MCP ASP",
  `#${OKX_ASP_ID} using the approved canonical payload at services/asp/generated/relisting-payload.json.`,
  "Do not register a new ASP.",
  `Do not use ${ERC8004_AGENT_ID} — that is the ERC-8004 agent id, not the ASP id.`,
].join(" ");

/** What a reviewer should run to check the listing without holding an Untch account. */
export function reviewerInstructions(payload: RelistingPayload): string {
  const free = payload.services.filter((s) => !s.paid);
  const paid = payload.services.filter((s) => s.paid);
  const lines: string[] = [
    "Every listed service can be checked from outside. No Untch account is needed for any step below.",
    "",
    "1. The contract, free to read, before spending anything:",
    `   GET ${PRODUCTION_BASE_URL}/catalog`,
    `   GET ${PRODUCTION_BASE_URL}/schema/<toolId>`,
    `   GET ${PRODUCTION_BASE_URL}/.well-known/x402`,
    `   GET ${PRODUCTION_BASE_URL}/payment-sdk-health   (per-route proof the official SDK is in the paid path)`,
    "",
    "2. The free services return their real result directly:",
    ...free.map((s) => `   ${s.method} ${s.endpoint}   → ${s.outputSummary}`),
    "",
    "3. The paid services answer 402 until paid, with the price, chain, token and payee in the",
    "   PAYMENT-REQUIRED header:",
    ...paid.map((s) => `   ${s.method} ${s.endpoint}   → 402, ${s.price} (${s.amountBaseUnits} base units)`),
    "",
    `   network ${payload.network} · token ${payload.settlementToken.address} (${payload.settlementToken.symbol}) · payTo ${payload.payTo}`,
    "",
    "4. Pay one and replay it. The response carries the promised result and the settlement evidence.",
    "",
    "Two of the paid services need something that exists before the call, and both say so in their",
    "own contract rather than only here:",
    `   preflight_payment needs a registered spend policy. Build it with POST ${PRODUCTION_BASE_URL}/consumer/policies/draft,`,
    `   send that transaction from your own wallet, then POST ${PRODUCTION_BASE_URL}/consumer/policies/sync.`,
    "   Untch does not relay the call and cannot — the policy's owner is whoever sent it.",
    `   verify_delivery needs an intent created on this host, which preflight_payment returns.`,
  ];
  return lines.join("\n");
}

/** Every service this host serves, so a reviewer can see what was NOT listed and why. */
export function withheldSummary(): { readonly toolId: string; readonly serviceClass: string; readonly reason: string }[] {
  return SERVICES.filter((s) => s.classification.serviceClass !== "MARKETPLACE_LISTABLE").map((s) => ({
    toolId: s.toolId,
    serviceClass: s.classification.serviceClass,
    reason: s.classification.reason,
  }));
}
