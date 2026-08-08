/**
 * The A2A agent card and MCP descriptor, at the paths an agent actually looks for.
 *
 * WHY THESE WERE MISSING
 *
 * Every standard A2A discovery path — `/.well-known/agent.json`, `/.well-known/agent-card.json`,
 * `/agent.json` — answered 404, while the ERC-8004 card at a non-standard path claimed the service
 * speaks A2A and A2MCP. An agent doing ordinary discovery found nothing and had no way to learn the
 * service exists, let alone what it sells.
 *
 * `/.well-known/mcp` was the same shape of problem in reverse: the registration card advertises
 * `A2MCP` as the protocol and the descriptor that would tell a client what that means was absent.
 *
 * WHAT THESE DOCUMENTS SAY, AND WHAT THEY CAREFULLY DO NOT
 *
 * They describe plain x402 HTTP tools. This host does NOT implement MCP's JSON-RPC `tools/list`
 * transport, and the descriptor says so in the document itself rather than letting a client discover it
 * by sending a JSON-RPC request that gets a 404. Claiming a transport that is not there is how a
 * listing becomes untrustworthy — the same failure as advertising an endpoint that 503s.
 *
 * Both are built from the registry with the same `MARKETPLACE_LISTABLE` + `PUBLIC_SUPPORT` rule the
 * catalog, the x402 document, the ERC-8004 card and the relisting payload use.
 */

import { ERC8004_AGENT_ID } from "../registry/marketplace-identity";
import { SERVICES } from "../registry/services";
import type { Route } from "./router";

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60",
    },
  });

/** Callable by a stranger. The one rule every public descriptor here shares. */
const offered = () =>
  SERVICES.filter(
    (s) =>
      s.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
      s.classification.serviceClass === "PUBLIC_SUPPORT",
  );

export function agentCardRoutes(baseUrl: string): readonly Route[] {
  const card = () =>
    json({
      /**
       * A2A's own field names. `protocolVersion` and `capabilities` are what a compliant client reads
       * first to decide whether it can talk to this host at all.
       */
      protocolVersion: "0.3.0",
      name: "Untch",
      description:
        "Spend governance for autonomous agents. Every payment is checked against a bounded intent " +
        "before it executes: the budget holds, the vendor is trusted, the call is not a duplicate, " +
        "and the amount stays under policy. The model never touches the money.",
      url: baseUrl,
      version: "1.0.0",
      documentationUrl: "https://docs.untch.xyz",
      provider: { organization: "Untch", url: "https://untch.xyz" },

      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },

      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],

      /**
       * A2A calls them skills; here each one is a real HTTP endpoint with a published contract and, if
       * priced, an x402 challenge. The price is stated on the skill rather than left to be discovered
       * by calling it and reading a 402.
       */
      skills: offered().map((s) => ({
        id: s.toolId,
        name: s.publicName,
        description: s.summary,
        tags: [s.classification.serviceClass, s.pricing.kind],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        endpoint: `${baseUrl}${s.path}`,
        method: s.method,
        pricing: s.pricing,
        schema: `${baseUrl}/schema/${s.toolId}`,
      })),

      /**
       * Stated plainly rather than implied. A client that needs a payment rail knows before it calls,
       * and a client that cannot pay knows which skills are free.
       */
      payments: {
        protocol: "x402",
        discovery: `${baseUrl}/.well-known/x402`,
        network: "eip155:196",
      },

      registrations: [
        {
          agentId: ERC8004_AGENT_ID,
          agentRegistry: "eip155:196:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
          card: `${baseUrl}/.well-known/agent-registration.json`,
        },
      ],
    });

  const mcp = () =>
    json({
      protocol: "A2MCP",
      name: "Untch",
      baseUrl,
      /**
       * The honest caveat, in the document rather than discovered by a failing request.
       *
       * These are plain x402 HTTP tools. There is no JSON-RPC endpoint, no `tools/list` method and no
       * session handshake, so a client expecting formal MCP transport should stop here rather than
       * send a request that would 404.
       */
      transport: "http",
      jsonRpc: false,
      note:
        "Plain x402 HTTP tools. This host does not implement MCP JSON-RPC transport — call each tool " +
        "directly at its endpoint. Paid tools answer 402 with an x402 challenge.",
      tools: offered().map((s) => ({
        name: s.toolId,
        title: s.publicName,
        description: s.summary,
        endpoint: `${baseUrl}${s.path}`,
        method: s.method,
        pricing: s.pricing,
        inputSchema: s.input,
        schema: `${baseUrl}/schema/${s.toolId}`,
      })),
    });

  /** Every path an A2A client is known to probe. One document, so they cannot drift apart. */
  return [
    { method: "GET", pattern: "/.well-known/agent.json", bodyMode: "none", handler: card },
    { method: "GET", pattern: "/.well-known/agent-card.json", bodyMode: "none", handler: card },
    { method: "GET", pattern: "/agent.json", bodyMode: "none", handler: card },
    { method: "GET", pattern: "/.well-known/mcp", bodyMode: "none", handler: mcp },
  ];
}

/** The paths this module serves, so the route classifier reads truth rather than a guess. */
export const AGENT_CARD_PATHS = [
  "/.well-known/agent.json",
  "/.well-known/agent-card.json",
  "/agent.json",
  "/.well-known/mcp",
] as const;
