import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * The thing whose absence made a 0.05 USDT0 transfer unattributable.
 *
 * WHAT HAPPENED
 *
 * A settlement appeared on chain and nothing in this service could say which request produced it. The
 * logs held startup lines and a treasury-drift counter. There was no route, no nonce, no status, no
 * transaction hash. Attribution took a block-by-block balance binary search and a decode of the raw
 * transaction input, and even then the answer came from outside the system.
 *
 * It turned out to be a first-party Brand Pack purchase on a different protocol path, so no safety
 * property was violated. The observability gap was real regardless: the same investigation would have
 * been necessary, and equally inconclusive, if a genuine defect HAD moved the money.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not change payment behaviour. It observes and records. `paymentMiddleware` still decides
 * what settles and when, and nothing here can prevent, delay or trigger a settlement — because a
 * logger with an opinion about money is a second payment path, and this incident is not an argument
 * for adding one.
 *
 * WHAT IT NEVER RECORDS
 *
 * No complete authorization, no signature, no bearer token, no secret. Nonces and idempotency keys
 * appear only as truncated one-way fingerprints: enough to correlate two log lines or a log line and a
 * transaction, never enough to redeem or replay anything.
 */

/** Truncated sha256. Correlates without being reversible or redeemable. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export interface SettlementObservation {
  readonly requestId: string;
  readonly route: string;
  readonly serviceId: string | null;
  readonly serviceCallId: string | null;
  readonly idempotencyKeyFingerprint: string | null;
  readonly authorizationNonceFingerprint: string | null;
  readonly payer: string | null;
  readonly amount: string | null;
  readonly recipient: string | null;
  readonly handlerStatus: number | null;
  /**
   * Whether settlement was REACHED, which is the question the audit turns on. A non-2xx returns before
   * `processSettlement`, so recording this separately from the status is what makes the claim testable
   * rather than argued from reading the library.
   */
  readonly processSettlementInvoked: boolean;
  readonly facilitatorAcceptedStatus: string | null;
  readonly facilitatorConfirmedStatus: string | null;
  readonly paymentId: string | null;
  readonly transactionHash: string | null;
  readonly settlementTimestamp: string | null;
  readonly settlementHeaderPresent: boolean;
}

export type ObservationSink = (o: SettlementObservation) => void;

/**
 * The default sink: one JSON line per priced request.
 *
 * Structured rather than prose so a future incident is a query instead of an archaeology exercise.
 */
export const consoleSettlementSink: ObservationSink = (o) => {
  console.log(`[x402-settlement] ${JSON.stringify(o)}`);
};

/**
 * Read what a settlement header actually says.
 *
 * The header is base64 JSON carrying the facilitator's own account of the settlement. Decoding it is
 * how `transaction` and `paymentId` reach the log without this module talking to the facilitator
 * itself, which would be a second network dependency on a path that must not fail.
 *
 * A settlement header is evidence of ACCEPTANCE. `status: "pending"` is reported by
 * `processSettlement` as success, so `facilitatorConfirmedStatus` is recorded separately and is only
 * `success` when the facilitator said exactly that.
 */
function readSettlementHeader(raw: string | null): {
  paymentId: string | null;
  transactionHash: string | null;
  accepted: string | null;
  confirmed: string | null;
} {
  if (!raw) return { paymentId: null, transactionHash: null, accepted: null, confirmed: null };
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    const status = typeof decoded.status === "string" ? decoded.status : null;
    return {
      paymentId: decoded.paymentId === undefined || decoded.paymentId === null ? null : String(decoded.paymentId),
      transactionHash:
        decoded.transaction === undefined || decoded.transaction === null ? null : String(decoded.transaction),
      accepted: decoded.success === true ? "accepted" : status,
      confirmed: status === "success" ? "success" : status,
    };
  } catch {
    return { paymentId: null, transactionHash: null, accepted: "unparseable", confirmed: null };
  }
}

const SETTLEMENT_HEADERS = ["payment-response", "x-payment-response", "payment-receipt"] as const;

/**
 * Observe a priced route.
 *
 * Mounted OUTSIDE `paymentMiddleware` so it sees the final response, including whatever settlement
 * headers the middleware attached. It hooks `finish`, which is the only moment the whole outcome is
 * known.
 *
 * `finish` is a reporting boundary here and nothing else. The approval path already learned, in the
 * settlement-boundary work, that it cannot be a correctness boundary — a process can die before it
 * fires. A missing log line is a gap in the record; the reconciler is what protects the money.
 */
export function observeSettlements(
  routes: readonly string[],
  sink: ObservationSink = consoleSettlementSink,
) {
  const watched = new Set(routes);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!watched.has(req.path)) return next();

    const requestId = randomUUID();
    res.setHeader("X-Untch-Request-Id", requestId);
    const startedAt = Date.now();

    res.on("finish", () => {
      try {
        let headerValue: string | null = null;
        for (const name of SETTLEMENT_HEADERS) {
          const v = res.getHeader(name);
          if (v !== undefined && v !== null) {
            headerValue = String(v);
            break;
          }
        }
        const settlement = readSettlementHeader(headerValue);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const idem = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;

        /**
         * The nonce comes from the presented authorization header, which is base64 JSON. Only its
         * fingerprint is kept, so two log lines can be tied together and a leaked log cannot spend
         * anything.
         */
        let nonceFp: string | null = null;
        let payer: string | null = null;
        let amount: string | null = null;
        let recipient: string | null = null;
        const presented = req.header("payment-signature") ?? req.header("x-payment");
        if (presented) {
          try {
            const decoded = JSON.parse(Buffer.from(presented, "base64").toString("utf8")) as Record<string, unknown>;
            const accepted = (decoded.accepted ?? {}) as Record<string, unknown>;
            const payload = (decoded.payload ?? {}) as Record<string, unknown>;
            const auth = (payload.authorization ?? {}) as Record<string, unknown>;
            if (typeof auth.nonce === "string") nonceFp = fingerprint(auth.nonce);
            if (typeof auth.from === "string") payer = auth.from;
            if (typeof accepted.amount === "string") amount = accepted.amount;
            if (typeof accepted.payTo === "string") recipient = accepted.payTo;
          } catch {
            nonceFp = "unparseable";
          }
        }

        sink({
          requestId,
          route: req.path,
          serviceId: typeof body.capability === "string" ? body.capability : null,
          serviceCallId: null,
          idempotencyKeyFingerprint: idem === null ? null : fingerprint(idem),
          authorizationNonceFingerprint: nonceFp,
          payer,
          amount,
          recipient,
          handlerStatus: res.statusCode,
          /**
           * Inferred from the header rather than instrumented inside the library. A settlement header
           * exists only when `processSettlement` ran, and its absence on a non-2xx is exactly the
           * property the 503 gate depends on. This is what makes that property observable in
           * production rather than only in an audit document.
           */
          processSettlementInvoked: headerValue !== null,
          facilitatorAcceptedStatus: settlement.accepted,
          facilitatorConfirmedStatus: settlement.confirmed,
          paymentId: settlement.paymentId,
          transactionHash: settlement.transactionHash,
          settlementTimestamp: headerValue === null ? null : new Date(startedAt).toISOString(),
          settlementHeaderPresent: headerValue !== null,
        });
      } catch {
        /**
         * An observer that can break a request is worse than one that misses a line. Payment behaviour
         * is unchanged by construction, including when this throws.
         */
      }
    });

    next();
  };
}
