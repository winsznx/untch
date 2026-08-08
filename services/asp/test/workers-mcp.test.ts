import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SERVICES } from "../src/registry/services";
import { asToolRequest, mcpJsonRpcRoutes } from "../src/workers/mcp-jsonrpc";

/**
 * The MCP handshake, pinned against what the OKX client actually does.
 *
 * `onchainos payment quote <url> --tool <name>` POSTs JSON-RPC `initialize`, then `tools/list`, then
 * `tools/call`. Against a GET-only descriptor every one of those 404'd, and the visible symptom was not
 * an error but a silence: `paramPlan: []` and `missingParams: []` on all six paid tools, so the client
 * sent an empty body to a tool that needed an object. These tests exist so that regression is loud.
 */

const routes = mcpJsonRpcRoutes({
  baseUrl: "https://asp.untch.xyz",
  callTool: async (path, method, _body, toolRequest) =>
    new Response(
      JSON.stringify({ calledPath: path, calledMethod: method, gatedUrl: toolRequest.url }),
      { status: 402, headers: { "content-type": "application/json", "payment-required": "x402" } },
    ),
});

const post = (path: string, body: unknown): Promise<Response> => {
  const route = routes.find((r) => r.pattern === path);
  assert.ok(route, `no MCP route serves ${path}`);
  return Promise.resolve(
    route.handler({
      request: new Request(`https://asp.untch.xyz${path}`, { method: "POST" }),
      body,
      params: {},
      url: new URL(`https://asp.untch.xyz${path}`),
    } as never),
  );
};

const rpc = async (method: string, params?: unknown) =>
  (await (await post("/mcp", { jsonrpc: "2.0", id: 1, method, params })).json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };

describe("the MCP handshake the OKX client performs", () => {
  test("initialize answers, which is where discovery previously died", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(result?.protocolVersion, "2025-06-18", "the client's protocol version must be met, not overridden");
    assert.ok((result?.capabilities as { tools?: unknown })?.tools, "a server with no tools capability is not asked for tools");
  });

  test("both paths a client is known to POST to are served", () => {
    for (const p of ["/mcp", "/.well-known/mcp"]) {
      assert.ok(routes.some((r) => r.pattern === p && r.method === "POST"), `${p} must accept POST JSON-RPC`);
    }
  });

  /**
   * THE POINT OF THE WHOLE MODULE.
   *
   * Without an inputSchema per tool the client cannot plan parameters. This is the assertion that would
   * have caught the buyer's `redact_payment_metadata` failure before the buyer did.
   */
  test("every listed tool ships the input schema the client plans parameters from", async () => {
    const { result } = await rpc("tools/list");
    const tools = result?.tools as { name: string; inputSchema?: { properties?: Record<string, unknown> } }[];
    assert.ok(tools.length > 0);

    for (const tool of tools) {
      assert.ok(tool.inputSchema, `${tool.name} has no inputSchema, so a client cannot plan its params`);
    }

    const redact = tools.find((t) => t.name === "redact_payment_metadata");
    assert.ok(redact, "the tool whose object-param was undiscoverable must be listed");
    assert.ok(
      redact.inputSchema?.properties?.metadata,
      "`metadata` must be discoverable as a property; a buyer had to hand-build this body because it was not",
    );
  });

  test("only publicly callable services are advertised", async () => {
    const { result } = await rpc("tools/list");
    const names = new Set((result?.tools as { name: string }[]).map((t) => t.name));
    for (const s of SERVICES) {
      const callable =
        s.classification.serviceClass === "MARKETPLACE_LISTABLE" ||
        s.classification.serviceClass === "PUBLIC_SUPPORT";
      assert.equal(
        names.has(s.toolId),
        callable,
        `${s.toolId} is ${s.classification.serviceClass} and must ${callable ? "" : "not "}be advertised`,
      );
    }
  });

  test("a priced tools/call returns the 402 itself, not a JSON-RPC wrapper", async () => {
    const res = await post("/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "suggest_names", arguments: { seed: "x" } },
    });
    assert.equal(res.status, 402, "the buyer's tooling parses the challenge from the status and headers");
    assert.ok(res.headers.get("payment-required"), "burying the challenge in a result makes it unreadable");
  });

  test("tools/call reaches the real route rather than a second copy of the handler", async () => {
    const res = await post("/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "suggest_names", arguments: {} },
    });
    const service = SERVICES.find((s) => s.toolId === "suggest_names")!;
    const body = (await res.json()) as { calledPath: string; calledMethod: string };
    assert.equal(body.calledPath, service.path);
    assert.equal(body.calledMethod, service.method);
  });

  /**
   * THE BUG THE LIVE CLI CAUGHT.
   *
   * x402 prices a request by pathname. The first cut handed the gate the JSON-RPC envelope's own `/mcp`
   * URL, which carries no price, so `payment quote --tool redact_payment_metadata` came back
   * "no payment required" and ran a paid handler for free. The gate must see the TOOL's path.
   */
  test("the gate is shown the tool's own URL, not the JSON-RPC envelope's", async () => {
    const res = await post("/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "redact_payment_metadata", arguments: { metadata: {} } },
    });
    const { gatedUrl } = (await res.json()) as { gatedUrl: string };
    const service = SERVICES.find((s) => s.toolId === "redact_payment_metadata")!;
    assert.equal(
      new URL(gatedUrl).pathname,
      service.path,
      "pricing keys off the pathname; /mcp has no price and would make a paid tool free",
    );
  });

  test("the re-addressed request keeps the payment authorization headers", () => {
    const envelope = new Request("https://asp.untch.xyz/mcp", {
      method: "POST",
      headers: { "x-payment": "eyJhbGc", "content-type": "application/json" },
    });
    const tool = asToolRequest(envelope, "/builder/suggest_names", "POST");
    assert.equal(new URL(tool.url).pathname, "/builder/suggest_names");
    assert.equal(tool.headers.get("x-payment"), "eyJhbGc", "dropping this would make every paid call unsettleable");
    assert.equal(tool.method, "POST");
  });

  test("an unknown tool is refused by name", async () => {
    const { error } = await rpc("tools/call", { name: "not_a_tool" });
    assert.equal(error?.code, -32601);
    assert.match(error!.message, /not_a_tool/);
  });

  test("a notification is acknowledged without a result envelope", async () => {
    const res = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202, "a notification carries no id, so a result would have nothing to answer");
  });
});
