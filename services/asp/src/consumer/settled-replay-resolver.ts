import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { requestFingerprint, type Pool } from "@untch/consumer-core";

/**
 * The thing that stops a lost response from being charged for twice.
 *
 * THE FAILURE
 *
 * A service fee settles, the approval activates, and the HTTP response never reaches the client. The
 * client retries with the same idempotency key and a FRESH payment authorization, because that is what
 * a correct x402 client does. The middleware settles on any 2xx. So a perfectly idempotent handler
 * returning the stored result would be charged a second time, and the second transfer would already be
 * on chain by the time any uniqueness constraint could object.
 *
 * WHY THIS RUNS BEFORE THE PAYMENT MIDDLEWARE
 *
 * `docs/architecture/approval-settlement-boundary.md` selected option A for exactly this reason. The
 * only signals `paymentMiddleware` honours for skipping settlement are a non-2xx status, which would
 * discard the body we want to return, and `SETTLEMENT_OVERRIDES_HEADER`, which alters settlement TERMS
 * rather than declining to charge. Both bend protocol semantics to carry an application decision.
 *
 * Mounted ahead of the gate, this answers and never calls `next()`, so `requiresPayment` is never
 * consulted, no authorization is inspected, and no settlement header is emitted. There is nothing to
 * skip because nothing started.
 *
 * WHAT IT REFUSES TO DO
 *
 * It answers ONLY for a FINALIZED service call. A settled-but-unfinalized call, a pending one and an
 * unknown one all fall through to the priced path, because answering those as a replay would hand out
 * a result nobody has yet proven was paid for. That distinction is the difference between this being a
 * safety mechanism and it being a way to get free work.
 *
 * It also requires a valid account session AND the exact idempotency identity before it returns
 * anything, so it cannot be used as an unauthenticated oracle for whether some call exists.
 */

export interface ReplayResolverDeps {
  readonly pool: Pool;
  /** Resolves a bearer to an account, or null. The same check the paid route itself uses. */
  readonly accountForSession: (authorization: string | undefined) => Promise<{ accountId: string } | null>;
}

interface StoredReplay {
  readonly serviceCallId: string;
  readonly state: string;
  readonly approvalRequestId: string | null;
  readonly approvalState: string | null;
  readonly approvalDigest: string | null;
  readonly activatedAt: string | null;
}

/**
 * Derive the same fingerprint the paid path derives.
 *
 * A client idempotency key is the CLIENT's namespace. Two different requests carrying one key must not
 * resolve to each other, so what a replay matches on includes terms the server derived rather than
 * only the key the caller chose.
 */
function fingerprintOf(body: Record<string, unknown>): string | null {
  const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const provider = s(body.provider);
  const capability = s(body.capability);
  const amount = s(body.maxSpend);
  const currency = s(body.currency);
  const deadline = s(body.deadline);
  if (!provider || !capability || !amount || !currency || !deadline) return null;
  return requestFingerprint({
    provider,
    capability,
    amount,
    currency,
    policyId: s(body.policyId),
    deadline,
  });
}

async function findFinalized(
  pool: Pool,
  accountId: string,
  route: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<StoredReplay | null> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT c.service_call_id, c.state,
            r.approval_request_id, r.state AS approval_state, r.approval_digest, r.activated_at
       FROM untch_x402_service_calls c
       LEFT JOIN untch_approval_requests r ON r.service_call_id = c.service_call_id
      WHERE c.account_id = $1 AND c.route = $2 AND c.idempotency_key = $3 AND c.request_fingerprint = $4`,
    [accountId, route, idempotencyKey, fingerprint],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    serviceCallId: String(row.service_call_id),
    state: String(row.state),
    approvalRequestId: row.approval_request_id === null ? null : String(row.approval_request_id),
    approvalState: row.approval_state === null ? null : String(row.approval_state),
    approvalDigest: row.approval_digest === null ? null : String(row.approval_digest),
    activatedAt: row.activated_at instanceof Date ? row.activated_at.toISOString() : null,
  };
}

/**
 * Mount ahead of `paymentMiddleware`.
 *
 * Its own JSON parser, scoped to this route, because the global `express.json()` is deliberately
 * mounted AFTER the payment gate so an unpaid request 402s without the body ever being read. Adding a
 * global parser earlier would quietly undo that.
 */
export function registerSettledReplayResolver(
  app: Express,
  route: string,
  /**
   * Read late, not captured. The pool and the session secret are built further down in server
   * construction, but this route has to be REGISTERED before the payment gate to sit in front of it.
   * A getter lets the position be fixed early and the dependencies arrive later, which is the same
   * shape `publicPreflightDeps` already uses.
   */
  getDeps: () => ReplayResolverDeps | null,
): void {
  const parse = express.json({ limit: "64kb" });

  app.post(route, (req: Request, res: Response, next: NextFunction) => {
    const deps = getDeps();
    if (!deps) return next();
    parse(req, res, (parseErr?: unknown) => {
      if (parseErr) return next();
      void (async () => {
        try {
          const body = (req.body ?? {}) as Record<string, unknown>;
          const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
          if (!idempotencyKey) return next();

          const fingerprint = fingerprintOf(body);
          if (!fingerprint) return next();

          /**
           * Authentication BEFORE the lookup, not after. Reversed, a caller could learn whether a
           * given idempotency key exists on an account they do not hold, which is a small oracle but
           * an oracle.
           */
          const account = await deps.accountForSession(req.header("authorization"));
          if (!account) return next();

          const found = await findFinalized(deps.pool, account.accountId, route, idempotencyKey, fingerprint);
          if (!found || found.state !== "FINALIZED") return next();

          /**
           * A replay of a completed paid call. No settlement header, because nothing settled here and
           * claiming one would be describing a transfer that did not happen on this request.
           */
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Idempotency-Replayed", "true");
          res.status(200).json({
            outcome: "ALREADY_SETTLED_REPLAY",
            replayed: true,
            servicePaymentSettled: true,
            servicePaymentSettledOnThisRequest: false,
            serviceCallId: found.serviceCallId,
            decisionOutcome: "ESCALATED_THRESHOLD",
            approvalRequestId: found.approvalRequestId,
            approvalState: found.approvalState,
            approvalDigest: found.approvalDigest,
            activatedAt: found.activatedAt,
            message:
              "this request was already completed and paid for. The original result is returned and no new payment was taken.",
            docsUrl: null,
          });
        } catch {
          /**
           * A resolver that cannot answer must never block the real route. Falling through means the
           * caller pays and gets a correct answer, which is worse than a free replay and far better
           * than a 500 on a request that was already paid for.
           */
          next();
        }
      })();
    });
  });
}
