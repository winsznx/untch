/**
 * What an Untch-owned service IS, stated once, in code, so a payment can be derived from it.
 *
 * WHY A DEFINITION AND NOT A PROMPT
 *
 * Every service in the Builder Pack backlog — GTM Package, Find Contacts, Battle Card, Builder
 * Package, Harden, Edge — is the same shape: take a brief, plan some work, spend a bounded amount on
 * evidence, produce files, and hand back a manifest of what was actually made. Implemented as six
 * endpoints, each holding its own prompt and its own idea of what "done" means, that shape is written
 * six times and diverges six ways. The one that matters is `artifactContract`: a service that returns
 * prose describing a file it never wrote is the failure mode this whole package exists to make
 * structurally impossible.
 *
 * WHY THE RECIPIENT LIVES HERE
 *
 * `preflight_payment` has to know who is paid before it can judge a payment. For a third-party
 * provider that address arrives in a live quote. For a service Untch performs itself there is no
 * quote and no third party — the address is a published property of the service, and reading it here
 * is a derivation from a committed, reviewable record.
 *
 * That is NOT the same as falling back to this host's `payTo`, which is the thing that must never
 * happen, and the difference is enforced by construction rather than by discipline: the resolver in
 * `public-dto/authority.ts` is given this table and is given no access to the host config at all. A
 * capability with no definition here cannot acquire a recipient by accident, because there is nothing
 * in scope for it to acquire one from.
 */

import type { Address } from "viem";

/** How honest a service is about its own readiness. Same ladder the provider registry uses. */
export type ServiceMaturity = "ALPHA" | "BETA" | "LIVE" | "PARTNER_ACCESS_REQUIRED" | "DISABLED";

/** How a service is priced. `fixed` is the only kind this pass implements. */
export interface ServicePricing {
  readonly kind: "fixed" | "quoted";
  /** Display price in the settlement currency, e.g. "4.00". Null when quoted. */
  readonly price: string | null;
  readonly currency: string;
}

/**
 * What the service promises to produce, by media type and name.
 *
 * `required: true` means the delivery manifest FAILS if the file is absent. That is the mechanism
 * behind "never claim a format exists when no file was created" — the claim is checked against the
 * artifact rows, not against the model's account of its own work.
 */
export interface ArtifactContractEntry {
  readonly name: string;
  readonly mimeType: string;
  readonly required: boolean;
  readonly description: string;
}

/** A confirmation gate the service will stop at. Declared up front so a caller knows it is coming. */
export interface CheckpointContractEntry {
  readonly type: string;
  readonly prompt: string;
  /** Whether the run halts here. A checkpoint that never halts is a log line, not a gate. */
  readonly blocking: boolean;
}

export interface ServiceDefinition {
  readonly serviceId: string;
  readonly version: string;
  readonly publicName: string;
  readonly maturity: ServiceMaturity;
  readonly pricing: ServicePricing;
  /** The capability ids this definition answers to, as a preflight request would name them. */
  readonly capabilities: readonly string[];
  /** The provider id a caller names to reach it. `untch` for everything this deployment performs. */
  readonly provider: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputContract: readonly ArtifactContractEntry[];
  readonly checkpointContract: readonly CheckpointContractEntry[];
  /**
   * The address this capability is paid at, or null when it is only ever priced by a live quote.
   *
   * Null is a legitimate value and produces `RECIPIENT_REQUIRED`, which is the correct answer for a
   * service whose price is not yet known.
   */
  readonly recipient: Address | null;
  readonly recipientDerivedFrom: string | null;
  /** The ERC-8004 agent id Untch performs this capability as, when one is registered. */
  readonly workerAgentId: string | null;
  readonly endpoint: string;
  readonly enabled: boolean;
  /** Maximum this service may spend on external evidence for ONE order, in display units. */
  readonly maxExternalCost: string;
}

/**
 * The X Layer address Untch's own services are paid at.
 *
 * This is the same address the x402 challenge publishes as `payTo`, and writing it out here rather
 * than importing the host's config is deliberate. Config is what a deployment sets; this is what the
 * SERVICE is. If they ever diverge, the receipt should say what the service published, and a reviewer
 * should be able to see the value being committed to without reading an environment.
 */
const UNTCH_XLAYER_RECEIVER: Address = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";

const RECEIVER_PROVENANCE =
  "the X Layer receiving address published in this deployment's own x402 challenge, named by the service definition rather than borrowed from host config";

/**
 * The ERC-8004 identity Untch acts under on the marketplace.
 *
 * Recorded from the registration performed in the mainnet pass. It is the WORKER side of an
 * owned-service payment: Untch is the agent being paid.
 */
const UNTCH_MARKETPLACE_ASP_AGENT_ID = "6086";

/**
 * `owned_work.demo` — the smallest real thing this runtime can be proven with.
 *
 * It exists so the policy journey can be walked end to end without buying anything from anybody: a
 * decision, an approval, a case, and a manifest whose single artifact is a record of the decision
 * itself. It produces a file, so the delivery-manifest check has something true to assert; it calls
 * no external service, so walking it costs nothing and can be repeated.
 */
const OWNED_WORK_DEMO: ServiceDefinition = {
  serviceId: "owned_work.demo",
  version: "1.0.0",
  publicName: "Owned work demo",
  maturity: "BETA",
  pricing: { kind: "fixed", price: "4.00", currency: "USDT0" },
  capabilities: ["owned_work.demo"],
  provider: "untch",
  inputSchema: {
    type: "object",
    title: "OwnedWorkDemoInput",
    properties: {
      note: { type: "string", maxLength: 500, description: "Anything you want recorded on the case." },
    },
    required: [],
  },
  outputContract: [
    {
      name: "demo-summary.json",
      mimeType: "application/json",
      required: true,
      description: "The decision, the policy that produced it, and the case it belongs to.",
    },
  ],
  checkpointContract: [],
  recipient: UNTCH_XLAYER_RECEIVER,
  recipientDerivedFrom: RECEIVER_PROVENANCE,
  workerAgentId: UNTCH_MARKETPLACE_ASP_AGENT_ID,
  endpoint: "https://asp.untch.xyz/owned/demo",
  enabled: true,
  maxExternalCost: "0.00",
};

/**
 * `battle_card` — the flagship slice, and the first service that produces something a person keeps.
 *
 * Priced above the demo because it does real work: it resolves two products, reads what each one
 * publishes about itself, and writes a comparison where every claim carries the source it came from.
 * The evidence contract is the product. A battle card whose claims cannot be traced is a document
 * somebody will quote in a sales call, and being wrong there costs more than being absent.
 */
const BATTLE_CARD: ServiceDefinition = {
  serviceId: "battle_card",
  version: "1.0.0",
  publicName: "Battle card",
  maturity: "BETA",
  pricing: { kind: "fixed", price: "6.00", currency: "USDT0" },
  capabilities: ["battle_card"],
  provider: "untch",
  inputSchema: {
    type: "object",
    title: "BattleCardInput",
    properties: {
      product: { type: "string", minLength: 1, description: "Your product's URL, or a description of it." },
      competitor: { type: "string", minLength: 1, description: "The competitor's URL or name." },
      persona: { type: "string", description: "Optional. Who the buyer is." },
      dealContext: { type: "string", description: "Optional. What is happening in the deal." },
      focusAreas: { type: "array", items: { type: "string" }, description: "Optional. What to weight." },
    },
    required: ["product", "competitor"],
  },
  outputContract: [
    { name: "battle-card.html", mimeType: "text/html", required: true, description: "The readable card, self-contained." },
    { name: "battle-card.json", mimeType: "application/json", required: true, description: "The same rows, structured." },
    { name: "evidence.json", mimeType: "application/json", required: true, description: "Every claim with its source and freshness." },
    { name: "delivery-manifest.json", mimeType: "application/json", required: true, description: "What was promised, what was produced, and the hashes." },
  ],
  checkpointContract: [
    {
      type: "CONFIRM_SCOPE",
      prompt: "These are the two products and the areas the card will cover. Confirm or edit before evidence is gathered.",
      blocking: false,
    },
  ],
  recipient: UNTCH_XLAYER_RECEIVER,
  recipientDerivedFrom: RECEIVER_PROVENANCE,
  workerAgentId: UNTCH_MARKETPLACE_ASP_AGENT_ID,
  endpoint: "https://asp.untch.xyz/owned/battle-card",
  enabled: true,
  maxExternalCost: "0.50",
};

/**
 * The services this deployment performs itself.
 *
 * Two, and the number is the honest one. The other six in the backlog have no definition here because
 * they have no implementation, and a definition without an implementation is exactly the claim this
 * package was built to prevent. They are named in the programme with their phase, not listed here
 * with a maturity that would make them look reachable.
 */
export const OWNED_SERVICES: readonly ServiceDefinition[] = Object.freeze([OWNED_WORK_DEMO, BATTLE_CARD]);

/** Look a service up the way a preflight request names it: by provider and capability. */
export function findOwnedService(provider: string, capability: string): ServiceDefinition | null {
  const p = provider.trim().toLowerCase();
  const c = capability.trim();
  return (
    OWNED_SERVICES.find(
      (s) => s.provider === p && s.capabilities.some((cap) => cap === c),
    ) ?? null
  );
}

/** Look a service up by its own id, for the paths that already know which service they are. */
export function ownedServiceById(serviceId: string, version?: string): ServiceDefinition | null {
  return (
    OWNED_SERVICES.find((s) => s.serviceId === serviceId && (version === undefined || s.version === version)) ?? null
  );
}
