/**
 * The Workers-native router, and the body-ordering rule it exists to enforce.
 *
 * WHY NOT KEEP EXPRESS
 *
 * Express needs a `listen`ing server and a Node request/response pair. A Worker has neither: it is
 * handed a Web `Request` and must return a `Response`. Shimming Express over that means carrying a
 * whole server abstraction to get path matching, which is the one thing here that is genuinely small.
 *
 * WHAT IS NOT SMALL, AND IS THE REASON THIS FILE HAS OPINIONS
 *
 * A `Request` body is a ONE-SHOT STREAM. Read it once and it is gone. Express's failure mode was a
 * JSON parser mounted above the Discord interactions route, which consumed `req.body` and left the
 * signature unverifiable forever. On Workers the same bug is easier to write and harder to see: any
 * middleware, logger or validation wrapper that calls `.json()` first spends the stream, and every
 * Discord signature then fails with nothing saying why.
 *
 * So body handling is part of the ROUTE DECLARATION rather than something layered above it:
 *
 *   bodyMode: "raw"    the handler receives the exact bytes, and nothing else may have read them
 *   bodyMode: "json"   parsed once at dispatch, after the route is known
 *   bodyMode: "form"   parsed once at dispatch
 *   bodyMode: "none"   the stream is never touched
 *
 * A route is matched BEFORE any body is read, so the mode of the matched route decides what happens
 * to the stream. There is no global parser to get the order wrong, and `assertRawBodyRoutesFirst`
 * turns "we ordered it correctly" into something a test can check.
 */

export type BodyMode = "raw" | "json" | "form" | "none";

export interface RouteMatch {
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
}

export interface RouteRequest extends RouteMatch {
  readonly request: Request;
  /** Shaped by the route's `bodyMode`: bytes, parsed value, form entries, or null. */
  readonly body: unknown;
  readonly rawBody: Uint8Array | null;
}

export type RouteHandler = (req: RouteRequest) => Promise<Response> | Response;

export interface Route {
  readonly method: string;
  /** `/consumer/approvals/:approvalRequestId/act` — the same patterns the Express routes use. */
  readonly pattern: string;
  readonly bodyMode: BodyMode;
  readonly handler: RouteHandler;
  /**
   * Whether the payment gate must run for this route.
   *
   * Declared per route rather than inferred from a path list, because a second hand-maintained list of
   * paid paths is exactly the drift that once billed twenty-six account-bound routes that could never
   * be served.
   */
  readonly priced?: boolean;
}

interface CompiledRoute extends Route {
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly segments: number;
}

function compile(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const source = route.pattern
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      paramNames.push(seg.slice(1));
      // Deliberately not matching `/`: a path parameter is one segment, so an id containing a slash
      // cannot silently traverse into a different route.
      return "([^/]+)";
    })
    .join("/");
  return {
    ...route,
    paramNames,
    regex: new RegExp(`^${source}/?$`),
    segments: route.pattern.split("/").length,
  };
}

export class WorkersRouter {
  private readonly routes: CompiledRoute[] = [];

  add(route: Route): this {
    this.routes.push(compile(route));
    return this;
  }

  addAll(routes: readonly Route[]): this {
    for (const r of routes) this.add(r);
    return this;
  }

  /**
   * Find the route WITHOUT touching the body.
   *
   * Separated from dispatch on purpose: knowing which route matched is what tells the caller whether
   * the bytes may be read as JSON or must be preserved exactly.
   */
  match(method: string, url: URL): { route: CompiledRoute; params: Record<string, string> } | null {
    const path = url.pathname;
    /**
     * Literal segments beat parameters. `/consumer/approvals/action/discord/interactions` must not be
     * captured by `/consumer/approvals/action/:actionReferenceId/start`-shaped patterns, and sorting
     * by parameter count makes that a property of the router rather than of declaration order.
     */
    const candidates = this.routes
      .filter((r) => r.method === method.toUpperCase())
      .sort((a, b) => a.paramNames.length - b.paramNames.length);

    for (const route of candidates) {
      const m = route.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1] as string);
      });
      return { route, params };
    }
    return null;
  }

  /** Every path that declares `bodyMode: "raw"`. Used by the ordering assertion and by tests. */
  rawBodyPaths(): readonly string[] {
    return this.routes.filter((r) => r.bodyMode === "raw").map((r) => r.pattern);
  }

  allRoutes(): readonly Route[] {
    return this.routes;
  }
}

/** Thrown when a raw-body route could be shadowed by something that parses first. */
export class RawBodyOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RawBodyOrderError";
  }
}

/**
 * Prove that no parsing route can swallow a raw-body route's path.
 *
 * The check is structural rather than a comment: for every `raw` route, no `json`/`form` route on the
 * same method may also match its literal path. If one does, a request to the raw path could be
 * dispatched to the parsing handler, the stream would be consumed, and the Discord signature would
 * never verify again.
 */
export function assertRawBodyRoutesFirst(router: WorkersRouter): void {
  const routes = router.allRoutes() as readonly CompiledRoute[];
  const raws = routes.filter((r) => r.bodyMode === "raw");

  for (const raw of raws) {
    // A literal path to test with: parameters filled with a plausible value.
    const probe = raw.pattern
      .split("/")
      .map((s) => (s.startsWith(":") ? "probe" : s))
      .join("/");

    for (const other of routes) {
      if (other === raw) continue;
      if (other.method !== raw.method) continue;
      if (other.bodyMode !== "json" && other.bodyMode !== "form") continue;
      if (other.regex.test(probe)) {
        throw new RawBodyOrderError(
          `${other.method} ${other.pattern} (bodyMode=${other.bodyMode}) also matches the raw-body route ` +
            `${raw.pattern}. A parsing route that can claim a raw path will consume the exact bytes a ` +
            "signature covers, and every signature then fails with nothing saying why.",
        );
      }
    }
  }
}

export interface DispatchOptions {
  /** Wraps a priced route. Supplied by the x402 Workers adapter; absent means nothing is priced. */
  readonly paymentGate?: (request: Request, body: unknown, run: () => Promise<Response>) => Promise<Response>;
  readonly onNotFound?: (req: Request) => Response;
  readonly maxBodyBytes?: number;
}

const jsonError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message, retryable: false, docsUrl: null }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Match, then read the body the matched route asked for, then run it.
 *
 * The order is the whole point. Nothing reads the stream before a route is chosen, so a raw route
 * always receives untouched bytes.
 */
export async function dispatch(
  router: WorkersRouter,
  request: Request,
  options: DispatchOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const found = router.match(request.method, url);
  if (!found) {
    return options.onNotFound?.(request) ?? jsonError(404, "ROUTE_NOT_FOUND", `no route for ${request.method} ${url.pathname}`);
  }

  const { route, params } = found;
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024;

  let body: unknown = null;
  let rawBody: Uint8Array | null = null;

  if (route.bodyMode !== "none" && request.body !== null) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      return jsonError(413, "REQUEST_TOO_LARGE", `body exceeded ${maxBytes} bytes`);
    }
    rawBody = bytes;

    if (route.bodyMode === "json") {
      const text = new TextDecoder().decode(bytes);
      if (text.trim() === "") body = null;
      else {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          return jsonError(400, "INVALID_JSON", "request body was not valid JSON");
        }
      }
    } else if (route.bodyMode === "form") {
      body = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bytes)));
    } else {
      // raw — the handler gets the bytes and nothing has parsed them.
      body = bytes;
    }
  }

  const routeRequest: RouteRequest = { request, params, url, body, rawBody };
  const run = (): Promise<Response> => Promise.resolve(route.handler(routeRequest));

  if (route.priced && options.paymentGate) {
    return options.paymentGate(request, body, run);
  }
  return run();
}
