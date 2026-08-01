import { randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";

/**
 * The last thing in the stack: every response leaves as JSON, including the ones nobody wrote.
 *
 * WHY THIS EXISTS
 *
 * Every route in this service answers in the §11 envelope `{code, message, retryable, docsUrl}` —
 * and then Express answered for the ones that did not exist. `GET /consumer/auth/nonce` returned the
 * default Express HTML 404 page, and that route is ADVERTISED in `/consumer/catalog` under both
 * `auth.obtain` and `publicRoutes`. A marketplace agent following the published catalog with the
 * wrong verb got an HTML page where a contract was promised. Any unmatched path did the same.
 *
 * Worse than the shape was what a thrown error did. With no error handler registered, Express's
 * default one takes over: HTML, with the stack trace attached whenever NODE_ENV is not "production".
 * A Postgres driver error carries the failing SQL. A provider adapter error can carry the provider's
 * response body. Neither belongs in a response to a caller who typed a URL wrong.
 *
 * WHY 405 AND NOT ONLY 404
 *
 * `POST /consumer/auth/nonce` works and `GET` does not. Answering both with 404 tells the caller the
 * route does not exist, which is false and sends them to look for a typo in the path. The boundary
 * asks the router which methods that exact path DOES accept and says so, with an `Allow` header. The
 * distinction is the difference between "you are in the wrong place" and "you are in the right place
 * with the wrong verb", and only the second one is actionable.
 *
 * WHY A CORRELATION ID INSTEAD OF A MESSAGE
 *
 * An unrecognised error is by definition one nobody decided was safe to publish. The honest answer is
 * a stable code and an identifier that ties the caller's copy to the log line holding the real cause.
 * Guessing that a message is publishable because it happens to read well is how a connection string
 * ends up in a 500 body.
 */

export interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly docsUrl: string | null;
}

export function errorEnvelope(
  code: string,
  message: string,
  retryable = false,
  docsUrl: string | null = null,
): ErrorEnvelope {
  return { code, message, retryable, docsUrl };
}

/** Short, unguessable, and cheap. It only has to be unique enough to grep a log for. */
export function newCorrelationId(): string {
  return `err_${randomBytes(8).toString("hex")}`;
}

/**
 * How a recognised domain error is answered.
 *
 * `publishMessage` is the load-bearing field. An error class earns it by having a message that was
 * WRITTEN for a caller — the state-machine errors say which transition was illegal and what to do
 * next, and that is the whole reason they are typed rather than bare. Everything else gets a fixed
 * sentence, because a message written for a log becomes a disclosure the moment it is served.
 */
interface PublishRule {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly publishMessage: boolean;
  /** Used when `publishMessage` is false. */
  readonly fixedMessage?: string;
}

/**
 * Keyed by `Error.name` rather than by constructor.
 *
 * Importing every class would couple this module to eight packages, and `instanceof` across a
 * workspace with duplicated module instances is a well-known way to silently stop matching. Each of
 * these classes sets `this.name` explicitly and is tested for it. The cost is that a new error class
 * defaults to INTERNAL_ERROR until it is added here — which is the correct default: an error nobody
 * has classified is an error nobody has decided is safe to publish.
 */
const PUBLISHABLE: Readonly<Record<string, PublishRule>> = {
  // Caller sent something malformed. The reasons list is the product.
  IntentValidationError: { status: 400, code: "INTENT_MALFORMED", retryable: false, publishMessage: true },
  PolicyValidationError: { status: 400, code: "POLICY_RULES_INVALID", retryable: false, publishMessage: true },
  ValidationError: { status: 400, code: "REQUEST_INVALID", retryable: false, publishMessage: true },
  MoneyParseError: { status: 400, code: "AMOUNT_INVALID", retryable: false, publishMessage: true },
  MoneyAssetMismatchError: { status: 400, code: "ASSET_MISMATCH", retryable: false, publishMessage: true },
  NegativeMoneyError: { status: 400, code: "AMOUNT_NEGATIVE", retryable: false, publishMessage: true },
  PeriodParseError: { status: 400, code: "PERIOD_INVALID", retryable: false, publishMessage: true },

  PolicyNotFoundError: { status: 404, code: "POLICY_NOT_FOUND", retryable: false, publishMessage: true },

  // Caller lost a race or asked for something the current state forbids. "Re-read and retry" is the
  // actionable part, and it is already in these messages.
  InvalidStateTransitionError: { status: 409, code: "ILLEGAL_STATE_TRANSITION", retryable: false, publishMessage: true },
  StaleIntentStateError: { status: 409, code: "INTENT_STATE_STALE", retryable: true, publishMessage: true },
  IdempotencyConflictError: { status: 409, code: "IDEMPOTENCY_KEY_REUSED", retryable: false, publishMessage: true },
  SupersedingReceiptConflictError: {
    status: 409,
    code: "RECEIPT_ALREADY_ANCHORED",
    retryable: false,
    publishMessage: true,
  },

  // The caller handed us a URL we refused to fetch. Saying so is the point of refusing.
  SsrfRefusedError: { status: 400, code: "DESTINATION_REFUSED", retryable: false, publishMessage: true },

  /**
   * A provider failed. The normalized CODE is published; the message is not.
   *
   * `ProviderError`'s message is `${code}: ${sanitizedProviderText}`, and sanitised is not the same as
   * intended-for-publication. A provider's own error text can name an account, an internal endpoint or
   * a quota, none of which the caller asked about.
   */
  ProviderError: {
    status: 502,
    code: "PROVIDER_FAILED",
    retryable: true,
    publishMessage: false,
    fixedMessage: "the upstream provider failed; the intent's own status carries the classified reason",
  },

  /**
   * A deployment is missing configuration. That is not the caller's fault and not the caller's
   * business: the variable NAME is not a secret, but publishing it maps this deployment's config
   * surface for anyone who probes routes until one 503s.
   */
  MissingEnvError: {
    status: 503,
    code: "SERVICE_NOT_CONFIGURED",
    retryable: false,
    publishMessage: false,
    fixedMessage: "this instance is not configured to serve that request",
  },
};

/** Minimal structural view of Express 4's router internals. Not `any`, and not a public API. */
interface RouteLayer {
  readonly route?: { readonly path: string | readonly string[]; readonly methods: Record<string, boolean> };
  readonly regexp?: { test(path: string): boolean };
}

interface RouterLike {
  readonly stack: readonly RouteLayer[];
}

/**
 * Which methods the router would accept for this exact path.
 *
 * Matched against each layer's compiled regexp rather than against the declared path string, so
 * parameterised routes (`/receipt_status/:receiptId`) answer correctly instead of only literal ones.
 */
export function allowedMethodsFor(app: Express, path: string): string[] {
  const router = (app as unknown as { _router?: RouterLike })._router;
  if (!router) return [];
  const methods = new Set<string>();
  for (const layer of router.stack) {
    if (!layer.route || !layer.regexp) continue;
    if (!layer.regexp.test(path)) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) methods.add(method.toUpperCase());
    }
  }
  if (methods.has("GET")) methods.add("HEAD");
  return [...methods].sort();
}

export interface ErrorBoundaryOptions {
  /** Where the real cause goes. Defaults to `console.error`. */
  readonly log?: (line: string) => void;
  readonly docsUrl?: string | null;
}

/**
 * Register the final 404/405 handler and the final error handler.
 *
 * MUST be called after every route, including the consumer and operator surfaces. Registered earlier
 * it would answer 404 for routes that had not been added yet.
 */
export function registerJsonErrorBoundary(app: Express, options: ErrorBoundaryOptions = {}): void {
  const log = options.log ?? ((line: string) => console.error(line));
  const docsUrl = options.docsUrl ?? null;

  app.use((req: Request, res: Response) => {
    const allow = allowedMethodsFor(app, req.path);
    if (allow.length > 0) {
      res.setHeader("Allow", allow.join(", "));
      res.status(405).json(
        errorEnvelope(
          "METHOD_NOT_ALLOWED",
          `${req.path} exists but does not accept ${req.method}; it accepts ${allow.join(", ")}`,
          false,
          docsUrl,
        ),
      );
      return;
    }
    res.status(404).json(
      errorEnvelope(
        "ROUTE_NOT_FOUND",
        `no route for ${req.method} ${req.path} — GET /catalog lists every tool this service serves`,
        false,
        docsUrl,
      ),
    );
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    // Express streams the body once headers are out; anything written here would corrupt it, so the
    // only correct move is to hand back to the default handler, which destroys the socket.
    if (res.headersSent) {
      next(err);
      return;
    }

    // A body that is not JSON is a caller mistake with an obvious fix, and it predates this boundary.
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json(errorEnvelope("BODY_NOT_JSON", "request body is not valid JSON", false, docsUrl));
      return;
    }

    const name = err instanceof Error ? err.name : "";
    const rule = PUBLISHABLE[name];
    if (rule) {
      const message =
        rule.publishMessage && err instanceof Error
          ? err.message
          : (rule.fixedMessage ?? "the request could not be completed");
      res.status(rule.status).json(errorEnvelope(rule.code, message, rule.retryable, docsUrl));
      return;
    }

    /**
     * Unrecognised. The caller gets a code and an id; the log gets everything.
     *
     * The stack is logged rather than served, which is the entire difference between this and what
     * Express did by default when NODE_ENV was anything other than "production" — and NODE_ENV is
     * not set on this deployment.
     */
    const correlationId = newCorrelationId();
    const detail = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    log(`[asp] ${correlationId} unhandled error on ${req.method} ${req.path}: ${detail}`);
    res.status(500).json({
      ...errorEnvelope(
        "INTERNAL_ERROR",
        "the request failed inside Untch; quote the correlationId when reporting it",
        true,
        docsUrl,
      ),
      correlationId,
    });
  });
}

/**
 * Keep the process alive when a promise nobody was awaiting rejects.
 *
 * WHY THIS IS HERE AND NOT IN `createSellerApp`
 *
 * This is process-level policy, and the app factory is also used by the local buyer driver and by
 * tests, which should keep the runner's own default. Only the real entry point installs it.
 *
 * WHY IT IS INSTALLED AT ALL
 *
 * `@okxweb3/x402-express` starts its facilitator initialisation per request and does not attach a
 * handler on every path. With the facilitator unreachable, one rejection settles after the response
 * has already been sent — and Node's default for an unhandled rejection is to TERMINATE. So an OKX
 * outage does not merely fail the paid routes; it restarts the container, repeatedly, taking the free
 * routes, the receipt status poll and the health endpoint down with them. The route-crawl suite
 * reproduces the rejection.
 *
 * The judgement being made is narrow. Crashing on an unknown state is often right for a job; it is
 * not right for a long-lived HTTP server whose failing subsystem is one middleware. The rejection is
 * recorded with the same correlation-id shape a 500 carries, so a log line here and a caller's
 * receipt of an INTERNAL_ERROR are the same kind of evidence. Nothing is swallowed silently.
 *
 * `uncaughtException` is deliberately NOT installed. A synchronous throw that escaped every frame
 * means the process's own invariants are gone, and continuing to serve from that state is how a
 * corrupted process writes something durable.
 */
export function installUnhandledRejectionGuard(log: (line: string) => void = (l) => console.error(l)): void {
  process.on("unhandledRejection", (reason: unknown) => {
    const correlationId = newCorrelationId();
    const detail = reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}` : String(reason);
    log(`[asp] ${correlationId} unhandled promise rejection (process kept alive): ${detail}`);
  });
}
