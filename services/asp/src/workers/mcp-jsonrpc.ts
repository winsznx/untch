/**
 * MCP over JSON-RPC 2.0, because that is how an OKX buyer actually discovers this service.
 *
 * WHY THIS WAS NEEDED
 *
 * `onchainos payment quote <url> --tool <name>` does not read a descriptive JSON document. It performs
 * a real MCP handshake — POST `initialize`, then `tools/list`, then `tools/call` — and parses the 402
 * that the call returns. Against a GET-only descriptor it failed with
 * `endpoint_unreachable: initialize returned HTTP 404`.
 *
 * The consequence was subtler than a failed probe. Without `tools/list` the client has no input schema
 * for any tool, so `payment quote` returned `missingParams: []` and `paramPlan: []` for every endpoint
 * and a standard-CLI buyer sent an empty body. That is exactly how an independent buyer's
 * `redact_payment_metadata` call died: it needs a `metadata` OBJECT, nothing told the client that, and
 * the only way through was hand-building the JSON and replaying the signature.
 *
 * So the schemas the registry already holds are now served where the client looks for them.
 *
 * WHAT tools/call DOES AND DOES NOT DO
 *
 * It does not re-implement anything. A paid tool's `tools/call` is answered with the SAME 402 the HTTP
 * route emits, because the payment decision belongs to the x402 gate and a second copy of it here would
 * be a second thing to get wrong. The JSON-RPC layer routes and shapes; it never prices.
 */

import { SERVICES } from "../registry/services";
import type { Route, RouteRequest } from "./router";

/** JSON-RPC 2.0 error codes, plus the one MCP adds for an unknown tool. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

const rpc = (id: unknown, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

const rpcError = (id: unknown, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    // 200 even for a JSON-RPC error: the transport succeeded, the CALL failed, and a client that
    // reads HTTP status instead of the envelope would mistake one for the other.
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

/** Callable by a stranger — the same rule every public descriptor here uses. */
const offered = () =>
  SERVICES.filter(
    (s) =>
      s.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
      s.classification.serviceClass === "PUBLIC_SUPPORT",
  );

export interface McpDeps {
  readonly baseUrl: string;
  /**
   * Runs a tool's real HTTP route and returns its response, payment gate included.
   *
   * Injected rather than imported so this module cannot become a second place where a price or a
   * payment verdict is decided. `toolRequest` is addressed to the tool's OWN path — see `asToolRequest`.
   */
  readonly callTool: (
    path: string,
    method: string,
    body: unknown,
    toolRequest: Request,
    req: RouteRequest,
  ) => Promise<Response>;
}

/**
 * Re-addresses the JSON-RPC request to the tool's own path.
 *
 * x402 prices a request by its PATHNAME. Handing the gate the envelope's `/mcp` URL made it look up a
 * path that carries no price, find none, and let a paid call through for free — `payment quote --tool
 * redact_payment_metadata` answered "no payment required" and ran the handler unpaid. Headers are
 * carried over unchanged so a real `x-payment` authorization still settles.
 */
export function asToolRequest(envelope: Request, path: string, method: string): Request {
  return new Request(new URL(path, envelope.url), { method, headers: envelope.headers });
}

export function mcpJsonRpcRoutes(deps: McpDeps): readonly Route[] {
  const handler = async (req: RouteRequest): Promise<Response> => {
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = (req.body ?? {}) as typeof msg;
    } catch {
      return rpcError(null, PARSE_ERROR, "request body was not valid JSON");
    }
    if (typeof msg.method !== "string") {
      return rpcError(msg.id ?? null, INVALID_REQUEST, "a JSON-RPC request needs a `method`");
    }

    switch (msg.method) {
      case "initialize":
        return rpc(msg.id ?? null, {
          /**
           * Echoed from the client when it names one. A client that speaks an older revision is better
           * served by being met there than by being told the version it asked for does not exist.
           */
          protocolVersion:
            typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "untch-asp", version: "1.0.0" },
          instructions:
            "Spend governance for autonomous agents. Paid tools answer HTTP 402 with an x402 challenge " +
            "on X Layer (eip155:196) in USDT0; free tools answer directly.",
        });

      // A notification carries no id and expects no result, only an acknowledgement.
      case "notifications/initialized":
      case "initialized":
        return new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } });

      case "ping":
        return rpc(msg.id ?? null, {});

      case "tools/list":
        return rpc(msg.id ?? null, {
          tools: offered().map((s) => ({
            name: s.toolId,
            description: `${s.summary} ${
              s.pricing.kind === "paid"
                ? `Costs ${s.pricing.price} USDT0 on X Layer, charged via x402.`
                : "Free."
            }`,
            /**
             * The registry's own input contract, which is the whole point of this endpoint: without it
             * a client cannot plan parameters and sends an empty body to a tool that needs an object.
             */
            inputSchema: s.input,
          })),
        });

      case "tools/call": {
        const name = typeof msg.params?.name === "string" ? msg.params.name : null;
        if (!name) return rpcError(msg.id ?? null, INVALID_REQUEST, "tools/call needs `params.name`");

        const service = offered().find((s) => s.toolId === name);
        if (!service) {
          return rpcError(msg.id ?? null, METHOD_NOT_FOUND, `no tool named ${JSON.stringify(name)}`);
        }

        const args = (msg.params?.arguments ?? {}) as unknown;
        const res = await deps.callTool(
          service.path,
          service.method,
          args,
          asToolRequest(req.request, service.path, service.method),
          req,
        );

        /**
         * A 402 is returned AS a 402, not wrapped in a JSON-RPC result.
         *
         * The client needs the `payment-required` header and the status to parse the challenge and
         * assemble a payment. Burying that in a JSON-RPC envelope would make the one response the
         * buyer's tooling is built to read unreadable.
         */
        if (res.status === 402) return res;

        const text = await res.text();
        return rpc(msg.id ?? null, {
          content: [{ type: "text", text }],
          isError: res.status >= 400,
        });
      }

      default:
        return rpcError(msg.id ?? null, METHOD_NOT_FOUND, `unsupported method ${JSON.stringify(msg.method)}`);
    }
  };

  /**
   * Both paths a client is known to POST to. `/.well-known/mcp` already answers GET with a descriptive
   * document; POST on the same path is the JSON-RPC transport, which is how MCP servers are normally
   * addressed.
   */
  return [
    { method: "POST", pattern: "/.well-known/mcp", bodyMode: "json", handler },
    { method: "POST", pattern: "/mcp", bodyMode: "json", handler },
  ];
}

/** The paths this module serves, so the route classifier reads truth rather than a guess. */
export const MCP_RPC_PATHS = ["/.well-known/mcp", "/mcp"] as const;
