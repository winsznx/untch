/**
 * The official OKX Payment SDK, on Cloudflare Workers.
 *
 * WHY THIS IS AN ADAPTER AND NOT A PAYMENT IMPLEMENTATION
 *
 * `@okxweb3/x402-express` is not the SDK. It is a 329-line shim over `x402HTTPResourceServer` from
 * `@okxweb3/x402-core/server`, which is already framework-agnostic and owns every decision that
 * matters: what a route costs, whether an authorization verifies, and whether a settlement confirmed.
 * The Express package contributes an `HTTPAdapter` (nine methods over the request) and the response
 * plumbing around `processSettlement`.
 *
 * So the Workers port is a second adapter over the SAME core, never a second payment parser. Every
 * 402 body, every price, every network and token check, and every settlement verdict still comes from
 * the SDK. If this file ever starts deciding whether a payment is valid, it is wrong.
 *
 * THE TWO PROPERTIES THE EXPRESS VERSION GETS FROM NODE STREAMS
 *
 * Both are load-bearing and neither is automatic on Workers, so both are reproduced deliberately.
 *
 *   1. THE RESPONSE IS BUFFERED, NOT STREAMED. Express monkey-patches `writeHead`/`write`/`end` and
 *      replays them only after settlement succeeds. The reason is that `processSettlement` takes the
 *      response body as input, and a body already on the wire cannot be un-sent if settlement then
 *      fails. Here that is `await response.arrayBuffer()` before settling.
 *
 *   2. A HANDLER 4xx/5xx SKIPS SETTLEMENT ENTIRELY. Express checks `res.statusCode >= 400` and
 *      replays the buffered response without charging. This is a correctness property, not an
 *      optimisation: a caller whose request failed must not be billed for the failure. Dropping it
 *      would charge for every refusal the ASP emits.
 */

import {
  FacilitatorResponseError,
  getFacilitatorResponseError,
  SETTLEMENT_OVERRIDES_HEADER,
  x402HTTPResourceServer,
  type HTTPAdapter,
  type HTTPRequestContext,
  type PaywallConfig,
  type PaywallProvider,
  type RoutesConfig,
  type x402ResourceServer,
} from "@okxweb3/x402-core/server";

/**
 * The nine methods the core asks for, over a Web `Request`.
 *
 * `body` is passed IN rather than read here. A `Request` body is a one-shot stream, and the route
 * handler downstream needs it too — so the boundary reads it exactly once and hands the parsed value
 * to both. An adapter that called `request.json()` itself would consume the stream and leave the
 * handler with nothing, which is the Workers-shaped version of the same bug the Discord route guards
 * against.
 */
export class WorkersHTTPAdapter implements HTTPAdapter {
  private readonly url: URL;

  constructor(
    private readonly request: Request,
    private readonly parsedBody: unknown,
  ) {
    this.url = new URL(request.url);
  }

  getHeader(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return this.url.pathname;
  }

  /**
   * The absolute URL, which the SDK puts in `resource` inside the 402 body.
   *
   * Cloudflare terminates TLS ahead of the Worker, and `request.url` already carries the external
   * scheme and host, so there is no `trust proxy` equivalent to get wrong here. It must stay https so
   * the resource identifier matches the marketplace listing.
   */
  getUrl(): string {
    return this.request.url;
  }

  getAcceptHeader(): string {
    return this.request.headers.get("Accept") ?? "";
  }

  getUserAgent(): string {
    return this.request.headers.get("User-Agent") ?? "";
  }

  getQueryParams(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const key of new Set(this.url.searchParams.keys())) {
      const all = this.url.searchParams.getAll(key);
      out[key] = all.length > 1 ? all : (all[0] as string);
    }
    return out;
  }

  getQueryParam(name: string): string | string[] | undefined {
    const all = this.url.searchParams.getAll(name);
    if (all.length === 0) return undefined;
    return all.length > 1 ? all : all[0];
  }

  getBody(): unknown {
    return this.parsedBody;
  }
}

/** What the gate hands a route handler: the original request plus the body already read off it. */
export interface PaidRequest {
  readonly request: Request;
  readonly body: unknown;
}

export type PaidHandler = (paid: PaidRequest) => Promise<Response> | Response;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The SDK's own instruction object, rendered as a `Response`. HTML and JSON both come from it. */
function fromInstructions(r: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}): Response {
  if (r.isHtml) {
    return new Response(String(r.body ?? ""), {
      status: r.status,
      headers: { "content-type": "text/html; charset=utf-8", ...r.headers },
    });
  }
  return json(r.status, r.body ?? {}, r.headers);
}

export interface WorkersPaymentGateOptions {
  readonly paywallConfig?: PaywallConfig;
  readonly paywall?: PaywallProvider;
  /**
   * Whether to sync facilitator support before the first protected request.
   *
   * On Workers this happens lazily on the first paid request rather than at module scope, because a
   * Worker isolate is created per colo and a network call at construction would make every cold start
   * wait on the facilitator even for free routes.
   */
  readonly syncFacilitatorOnStart?: boolean;
  /**
   * Called after a settlement the facilitator confirmed, with the facts of the transfer.
   *
   * A hook rather than a database call inside the adapter, because this module deliberately knows
   * nothing about storage — the same reason it takes a route table instead of reading one. It fires
   * only on confirmed success, so a refused or failed settlement can never be recorded as a sale.
   */
  readonly onSettled?: (facts: SettlementFacts) => void | Promise<void>;
}

/** What the seller needs to reconcile a sale, taken from what the SDK already verified. */
export interface SettlementFacts {
  readonly route: string;
  readonly payer: string;
  readonly payTo: string;
  readonly token: string;
  readonly network: string;
  readonly amountBaseUnits: string;
  readonly transactionHash: string | null;
  readonly facilitatorStatus: string | null;
  readonly responseStatus: number;
  readonly responseBytes: number;
  readonly authorizationNonce: string | null;
}

/** Dig a value out of the SDK payload without assuming one shape across versions. */
function pick(o: unknown, ...keys: readonly string[]): string | null {
  if (!o || typeof o !== "object") return null;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
    if (v && typeof v === "object") {
      const nested = pick(v, ...keys);
      if (nested) return nested;
    }
  }
  return null;
}

export interface WorkersPaymentGate {
  /**
   * Run the gate for one request.
   *
   * Returns the SDK's response when payment is required and absent or invalid, and otherwise calls
   * `handler` and returns its response — settled, when the route is priced and the handler succeeded.
   */
  (
    request: Request,
    body: unknown,
    handler: PaidHandler,
    /**
     * Where to record a confirmed settlement, supplied PER CALL.
     *
     * The gate is memoised per isolate so the facilitator handshake happens once. The place a sale is
     * written is not isolate state — it belongs to the request in flight — so it is passed in rather
     * than captured at construction. Capturing it meant concurrent requests recorded against whichever
     * request happened to write the shared reference last.
     */
    onSettled?: (facts: SettlementFacts) => void | Promise<void>,
  ): Promise<Response>;
}

/**
 * Build the payment gate.
 *
 * Mirrors `paymentMiddleware(routes, server)` from `@okxweb3/x402-express` — same core class, same
 * route table, same paywall hooks — with Web `Request`/`Response` at the edges.
 */
export function workersPaymentGate(
  routes: RoutesConfig,
  server: x402ResourceServer,
  options: WorkersPaymentGateOptions = {},
): WorkersPaymentGate {
  return workersPaymentGateFromHTTPServer(new x402HTTPResourceServer(server, routes), options);
}

/**
 * The same gate over an already-constructed `x402HTTPResourceServer`.
 *
 * `@okxweb3/x402-express` exposes exactly this pair, and for the same reason: the route table and the
 * core belong to the caller, so a test can drive the adapter's own behaviour — buffering, the 4xx
 * settlement guard, override forwarding — without standing up a facilitator to answer questions this
 * file does not ask.
 */
export function workersPaymentGateFromHTTPServer(
  httpServer: x402HTTPResourceServer,
  options: WorkersPaymentGateOptions = {},
): WorkersPaymentGate {
  if (options.paywall) httpServer.registerPaywallProvider(options.paywall);

  const syncOnStart = options.syncFacilitatorOnStart ?? true;
  let initPromise: Promise<unknown> | null = null;
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (!syncOnStart || initialized) return;
    initPromise ??= httpServer.initialize();
    try {
      await initPromise;
      initialized = true;
    } catch (err) {
      // Cleared so a transient facilitator outage does not poison the isolate for its whole lifetime.
      initPromise = null;
      throw err;
    }
  }

  return async function gate(
    request: Request,
    body: unknown,
    handler: PaidHandler,
    onSettled?: (facts: SettlementFacts) => void | Promise<void>,
  ): Promise<Response> {
    const adapter = new WorkersHTTPAdapter(request, body);
    // Both spellings, in the SDK's own precedence order. Omitted entirely when absent rather than set
    // to undefined: `exactOptionalPropertyTypes` is on, and "no payment header" and "a payment header
    // whose value is undefined" are not the same statement to make to the core.
    const paymentHeader = adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment");
    const context: HTTPRequestContext = {
      adapter,
      path: adapter.getPath(),
      method: adapter.getMethod(),
      ...(paymentHeader === undefined ? {} : { paymentHeader }),
    };

    if (!httpServer.requiresPayment(context)) {
      return handler({ request, body });
    }

    if (syncOnStart && !initialized) {
      try {
        await ensureInitialized();
      } catch (err) {
        const facilitatorError = getFacilitatorResponseError(err);
        if (facilitatorError) return json(502, { error: facilitatorError.message });
        throw err;
      }
    }

    let result;
    try {
      result = await httpServer.processHTTPRequest(context, options.paywallConfig);
    } catch (err) {
      if (err instanceof FacilitatorResponseError) return json(502, { error: err.message });
      throw err;
    }

    if (result.type === "no-payment-required") return handler({ request, body });
    if (result.type === "payment-error") return fromInstructions(result.response);

    const { paymentPayload, paymentRequirements, declaredExtensions } = result;

    const handlerResponse = await handler({ request, body });

    /**
     * Buffered here, before any settlement decision. `processSettlement` needs the bytes, and a
     * streamed body could not be withdrawn if settlement then failed.
     */
    const responseBytes = new Uint8Array(await handlerResponse.clone().arrayBuffer());
    const responseHeaders = new Headers(handlerResponse.headers);

    /**
     * A failed handler is never charged for.
     *
     * The same guard as `if (res.statusCode >= 400)` in the Express middleware. Without it every
     * refusal the ASP emits — a capability gate, a validation error, a 500 — would settle a payment
     * for work that did not happen.
     */
    if (handlerResponse.status >= 400) {
      return handlerResponse;
    }

    const overrides = responseHeaders.get(SETTLEMENT_OVERRIDES_HEADER);
    const settleHeaders: Record<string, string> = {};
    if (overrides) {
      settleHeaders[SETTLEMENT_OVERRIDES_HEADER] = overrides;
      responseHeaders.delete(SETTLEMENT_OVERRIDES_HEADER);
    }

    let settleResult;
    try {
      settleResult = await httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        {
          request: context,
          // The core's signature is Node-flavoured; the bytes are what it actually reads.
          responseBody: responseBytes as unknown as Buffer,
          responseHeaders: settleHeaders,
        },
      );
    } catch (err) {
      if (err instanceof FacilitatorResponseError) return json(502, { error: err.message });
      /**
       * The Express middleware answers a bare 402 here rather than leaking the handler's body.
       * Matched exactly: the work may have happened, but no settlement was confirmed, and returning
       * the result would be giving the product away on an unproven payment.
       */
      console.error("[x402-workers] settlement failed", err);
      return json(402, {});
    }

    if (!settleResult.success) {
      const failure = fromInstructions(settleResult.response);
      for (const [k, v] of Object.entries(settleResult.headers)) failure.headers.set(k, v);
      return failure;
    }

    for (const [k, v] of Object.entries(settleResult.headers)) responseHeaders.set(k, v);

    /**
     * Recorded only here — after the facilitator confirmed, and only on success.
     *
     * Everything above this line either refused, failed or never charged, so nothing above it is a
     * sale. Awaited rather than fired and forgotten: a Worker isolate can be frozen the moment the
     * response is returned, and an un-awaited write is a write that may simply not happen.
     */
    const settledHook = onSettled ?? options.onSettled;
    if (settledHook) {
      const settleBody = (settleResult as unknown as { response?: { body?: unknown } }).response?.body;
      await settledHook({
        route: adapter.getPath(),
        payer: pick(paymentPayload, "payer", "from", "sender") ?? "unknown",
        payTo: pick(paymentRequirements, "payTo", "recipient") ?? "unknown",
        token: pick(paymentRequirements, "asset", "token", "currency") ?? "unknown",
        network: pick(paymentRequirements, "network", "chain") ?? "unknown",
        amountBaseUnits:
          pick(paymentRequirements, "amount", "maxAmountRequired", "amountBaseUnits") ?? "unknown",
        transactionHash: pick(settleBody, "transaction", "transactionHash", "txHash", "hash"),
        facilitatorStatus: pick(settleBody, "status", "settleStatus"),
        responseStatus: handlerResponse.status,
        responseBytes: responseBytes.byteLength,
        authorizationNonce: pick(paymentPayload, "nonce", "authorizationNonce"),
      });
    }

    return new Response(responseBytes, {
      status: handlerResponse.status,
      statusText: handlerResponse.statusText,
      headers: responseHeaders,
    });
  };
}
