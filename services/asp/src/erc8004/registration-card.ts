/**
 * Off-chain ERC-8004 registration JSON for Untch ASP.
 * Required fields: type, name, description, image.
 * Build-required: services, registrations (after mint), x402Support, supportedTrust.
 */

import {
  AGENT_REGISTRATION_PATH,
  DEFAULT_AGENT_IMAGE_URL,
  DEFAULT_AGENT_URI,
  ERC8004_AGENT_REGISTRY,
  ERC8004_REGISTRATION_TYPE,
} from "./constants";
import { SERVICES } from "../registry/services";

export type AgentService = {
  readonly name: string;
  readonly endpoint: string;
  readonly version?: string;
  readonly skills?: readonly string[];
  readonly domains?: readonly string[];
  readonly description?: string;
};

export type AgentRegistration = {
  readonly agentId: number;
  readonly agentRegistry: string;
};

export type RegistrationCard = {
  readonly type: typeof ERC8004_REGISTRATION_TYPE;
  readonly name: string;
  readonly description: string;
  readonly image: string;
  readonly services: readonly AgentService[];
  readonly x402Support: true;
  readonly active: boolean;
  readonly registrations: readonly AgentRegistration[];
  readonly supportedTrust: readonly string[];
  /** Non-normative extension for operators / explorers. */
  readonly metadata?: {
    readonly baseUrl: string;
    readonly network: string;
    readonly payTo: string | null;
    readonly catalog: string;
    readonly agentUri: string;
    readonly wellKnown: string;
    readonly note: string;
  };
};

export type RegistrationCardConfig = {
  readonly agentId?: number | null;
  readonly imageUrl?: string;
  readonly payTo?: string | null;
  readonly baseUrl?: string;
  readonly forceActive?: boolean;
};

const SHORT_DESCRIPTION =
  "You want to fund an autonomous agent without letting it waste your money or get drained by a bad counterparty. " +
  "Untch is the control plane that makes agent spend safe to fund. Every payment is checked against a bounded intent " +
  "before it executes: the budget holds, the vendor is trusted, the call is not a duplicate, and the amount stays under policy. " +
  "Delivery is verified against a declared proof tier before funds count as earned. Every decision is receipted on X Layer. " +
  "Your agent requests the spend. The policy engine decides. The model never touches the money. " +
  "Hireable tools: policy preflight, delivery verify, bureau scores, café demo, and Launch Pack brand naming with live RDAP.";

function buildServices(baseUrl: string, payTo: string | null): AgentService[] {
  const asp = baseUrl.replace(/\/$/, "");
  const services: AgentService[] = [
    {
      name: "web",
      endpoint: "https://www.untch.xyz/",
      version: "1.0.0",
      description: "Operator dashboard, explorer, pricing, product site",
    },
    {
      name: "web",
      endpoint: "https://docs.untch.xyz/",
      version: "1.0.0",
      description: "Self-hosted product docs",
    },
    {
      name: "A2MCP",
      endpoint: `${asp}/catalog`,
      version: "1.0.0",
      description:
        "Untch multi-service ASP catalog (plain x402 HTTP tools; not a formal MCP JSON-RPC host)",
    },
    /**
     * One entry per registered service, generated rather than typed.
     *
     * These were eleven hand-written strings, and they were one of the six places the same contract
     * was described. `/agent-registration.json` said policy preflight was "13 RULE_EVAL,
     * deterministic, no LLM on money path" — accurate about the engine, silent about every parameter,
     * and unreconciled against the validator that demanded seventeen fields. Each entry now carries
     * the registry's own summary and a link to the full contract, so a reader of the card and a
     * reader of the schema cannot be told different things.
     *
     * `version` is the service's schemaVersion, not a build number: what a consumer of this card
     * needs to know is whether the CONTRACT changed.
     */
    /**
     * Only the services a stranger reading this card can actually call.
     *
     * It listed every entry in the registry — around twenty-five endpoints — including account-control
     * routes that need an account the reader does not have, Bureau tools that refuse before payment,
     * and the disabled café simulation. After the Cloudflare port most of those answer 503, so the
     * card became a public descriptor pointing largely at dead ends.
     *
     * `MARKETPLACE_LISTABLE` plus `PUBLIC_SUPPORT` is the same rule the catalog, the x402 document and
     * the relisting payload use. Four surfaces, one definition of what is on offer — which is the whole
     * reason the classification exists.
     */
    ...SERVICES.filter(
      (service) =>
        service.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
        service.classification.serviceClass === "PUBLIC_SUPPORT",
    ).map((service) => ({
      name: "service" as const,
      endpoint: `${asp}${service.path}`,
      version: service.schemaVersion,
      description: `${service.publicName} — ${service.summary} Contract: ${asp}/schema/${service.toolId}`,
    })),
    {
      name: "OASF",
      endpoint: `${asp}/catalog`,
      version: "v0.8.0",
      skills: [
        "finance_and_business/payment_processing",
        "finance_and_business/risk_and_compliance",
        "data_engineering/data_validation",
        "natural_language_processing/named_entity_recognition",
      ],
      domains: [
        "finance_and_business/payments",
        "finance_and_business/agent_commerce",
        "technology/software_services",
      ],
      description: "Spend control, policy preflight, receipts, bureau, Launch Pack",
    },
  ];

  if (payTo && /^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    services.push({
      name: "agentWallet",
      endpoint: `eip155:196:${payTo}`,
      version: "1.0.0",
      description: "x402 settlement payTo (USDT0 on X Layer). On-chain agentWallet set via setAgentWallet after mint.",
    });
  }

  return services;
}

/**
 * Build the registration card. active=true only when agentId is known (mint complete)
 * unless forceActive is set for local testing.
 */
export function buildRegistrationCard(cfg: RegistrationCardConfig = {}): RegistrationCard {
  const baseUrl = (cfg.baseUrl ?? process.env.ASP_PUBLIC_URL ?? "https://asp.untch.xyz").replace(
    /\/$/,
    "",
  );
  const image =
    cfg.imageUrl?.trim() ||
    process.env.ERC8004_IMAGE_URL?.trim() ||
    DEFAULT_AGENT_IMAGE_URL;
  const payTo = cfg.payTo ?? process.env.PAY_TO_ADDRESS?.trim() ?? null;

  const envId = process.env.ERC8004_AGENT_ID?.trim();
  const parsedEnv =
    envId && /^\d+$/.test(envId) ? Number(envId) : null;
  const agentId =
    cfg.agentId !== undefined && cfg.agentId !== null
      ? cfg.agentId
      : parsedEnv;

  const registrations: AgentRegistration[] =
    agentId !== null && agentId !== undefined && Number.isFinite(agentId)
      ? [{ agentId: Number(agentId), agentRegistry: ERC8004_AGENT_REGISTRY }]
      : [];

  const active =
    cfg.forceActive === true
      ? true
      : process.env.ERC8004_ACTIVE === "true"
        ? registrations.length > 0
        : registrations.length > 0;

  const agentUri = `${baseUrl}${AGENT_REGISTRATION_PATH}`;
  const wellKnown = `${baseUrl}/.well-known/agent-registration.json`;

  return {
    type: ERC8004_REGISTRATION_TYPE,
    name: "Untch: Spend Control for Agents",
    description: SHORT_DESCRIPTION,
    image,
    services: buildServices(baseUrl, payTo),
    x402Support: true,
    active,
    registrations,
    supportedTrust: ["reputation", "crypto-economic"],
    metadata: {
      baseUrl,
      network: "eip155:196",
      payTo,
      catalog: `${baseUrl}/catalog`,
      agentUri: process.env.ERC8004_AGENT_URI?.trim() || agentUri || DEFAULT_AGENT_URI,
      wellKnown,
      note:
        "A2MCP = plain x402 HTTP tools on this host (no formal MCP tools/list JSON-RPC). " +
        "Policy/preflight are LLM-free. Launch Pack may use LLM for naming only. " +
        "Set ERC8004_AGENT_ID after Identity register() mint to fill registrations[] and activate.",
    },
  };
}

/** Domain-proof file: full card (includes registrations when set). */
export function buildDomainProofCard(cfg: RegistrationCardConfig = {}): RegistrationCard {
  return buildRegistrationCard(cfg);
}
