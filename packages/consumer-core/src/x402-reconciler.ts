import type { Pool } from "./db";
import {
  finalizeSettlement,
  SettlementEvidenceError,
  type AuthorizedTerms,
  type FinalizeResult,
  type SettlementEvidence,
} from "./x402-service-calls";

/**
 * The part that makes correctness independent of whether anybody was listening.
 *
 * `response.finish` can trigger finalization and usually will. It cannot be the boundary, because the
 * process can die after settlement and before the callback, after the callback and before the
 * finalizer commits, or after the commit and before the client is answered. The audit's cut point 4 is
 * the one that forces this: a settlement can succeed before the service has recorded the transaction
 * hash at all, and no in-process signal can recover that. Only asking an authority can.
 *
 * So this exists to be the thing that finishes the job when nothing else did, and it must be safe to
 * run on every replica at once, forever, without ever moving money.
 */

/**
 * What the reconciler is allowed to ask.
 *
 * Narrow on purpose. It can look up a settlement and it can do nothing else, so no future edit can
 * turn reconciliation into a thing that submits a payment.
 */
export interface SettlementOracle {
  /**
   * Ask the authority about a settlement.
   *
   * Implementations must NOT infer success from a middleware boolean. `facilitator_success` is only a
   * legitimate source when it carries a transaction hash, because `processSettlement` reports a
   * pending settlement as `success: true` and a pending settlement is not a confirmed one.
   */
  settlementFor(args: {
    readonly terms: AuthorizedTerms;
    readonly transactionHash: string | null;
    readonly paymentId: string | null;
  }): Promise<SettlementEvidence>;
}

export interface ReconcileReport {
  readonly claimed: number;
  readonly activated: number;
  readonly failed: number;
  readonly leftUnresolved: number;
  readonly alreadyActive: number;
  readonly errors: readonly { readonly serviceCallId: string; readonly message: string }[];
}

/**
 * One pass.
 *
 * Each service call is claimed, resolved and committed in its OWN transaction rather than the whole
 * batch sharing one. A batch transaction would mean one unresolvable call holding locks over every
 * other call's activation, and a rollback throwing away work that had already succeeded.
 */
export async function reconcileOnce(
  pool: Pool,
  oracle: SettlementOracle,
  opts: { readonly limit?: number; readonly now?: () => string } = {},
): Promise<ReconcileReport> {
  const limit = opts.limit ?? 20;
  const errors: { serviceCallId: string; message: string }[] = [];
  let activated = 0;
  let failed = 0;
  let leftUnresolved = 0;
  let alreadyActive = 0;

  /**
   * FOR UPDATE SKIP LOCKED is what makes two replicas cooperate rather than collide: a row another
   * worker is holding is stepped over instead of waited on, so neither blocks and neither does the
   * same work twice.
   *
   * The candidate read is its own short transaction. Holding the claim across the oracle call would
   * keep a database transaction open for the length of a network round trip to the facilitator.
   */
  const client = await pool.connect();
  let candidates: { serviceCallId: string; nonce: string; terms: AuthorizedTerms; tx: string | null; paymentId: string | null }[] = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT c.service_call_id, a.authorization_nonce, a.payer, a.token, a.amount, a.pay_to, a.chain,
              a.transaction_hash, a.payment_id
         FROM untch_x402_service_calls c
         JOIN untch_x402_payment_attempts a ON a.service_call_id = c.service_call_id
        WHERE c.state IN ('SETTLEMENT_PENDING', 'SETTLED', 'FINALIZATION_PENDING', 'PAYMENT_AUTH_VERIFIED')
          AND a.state IN ('VERIFIED', 'SETTLEMENT_PENDING', 'UNKNOWN', 'SETTLED')
        ORDER BY c.updated_at ASC
        LIMIT $1
          FOR UPDATE OF c SKIP LOCKED`,
      [limit],
    );
    candidates = rows.map((r) => ({
      serviceCallId: String(r.service_call_id),
      nonce: String(r.authorization_nonce),
      terms: {
        authorizationNonce: String(r.authorization_nonce),
        payer: String(r.payer),
        token: String(r.token),
        amount: String(r.amount),
        payTo: String(r.pay_to),
        chain: String(r.chain),
      },
      tx: r.transaction_hash === null ? null : String(r.transaction_hash),
      paymentId: r.payment_id === null ? null : String(r.payment_id),
    }));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  for (const candidate of candidates) {
    let evidence: SettlementEvidence;
    try {
      evidence = await oracle.settlementFor({
        terms: candidate.terms,
        transactionHash: candidate.tx,
        paymentId: candidate.paymentId,
      });
    } catch (err) {
      /**
       * An oracle that threw is NOT a failed settlement. Recording it as one would mark a possibly
       * paid call unpayable and strand a real transfer. Unknown stays unknown.
       */
      evidence = { kind: "UNKNOWN", detail: `oracle error: ${(err as Error).message}` };
    }

    const work = await pool.connect();
    try {
      await work.query("BEGIN");
      const result: FinalizeResult = await finalizeSettlement(work, {
        serviceCallId: candidate.serviceCallId,
        evidence,
        ...(opts.now ? { now: opts.now } : {}),
      });
      await work.query("COMMIT");
      if (result.outcome === "ACTIVATED") activated += 1;
      else if (result.outcome === "PAYMENT_FAILED") failed += 1;
      else if (result.outcome === "ALREADY_ACTIVE") alreadyActive += 1;
      else leftUnresolved += 1;
    } catch (err) {
      await work.query("ROLLBACK").catch(() => undefined);
      const message = err instanceof SettlementEvidenceError ? `${err.code}: ${err.message}` : (err as Error).message;
      errors.push({ serviceCallId: candidate.serviceCallId, message });
    } finally {
      work.release();
    }
  }

  return { claimed: candidates.length, activated, failed, leftUnresolved, alreadyActive, errors };
}

/**
 * An oracle backed by the facilitator's own settlement-status API.
 *
 * `getSettleStatus` is the authority named in the boundary document, and it is implemented by
 * `OKXFacilitatorClient` in the installed package. This wrapper exists so the reconciler depends on an
 * interface it can be tested against rather than on a protocol client it would have to stand up.
 */
export function facilitatorOracle(client: {
  getSettleStatus(txHash: string): Promise<{ success: boolean; status?: string }>;
}): SettlementOracle {
  return {
    async settlementFor({ terms, transactionHash, paymentId }) {
      /**
       * No hash means nothing was ever submitted for this authorization, or the submission's result
       * never reached us. Either way there is nothing to ask about, and a facilitator cannot be
       * queried by nonce. UNKNOWN is the honest answer, and the attempt ages out through its own
       * validity window rather than being declared failed here.
       */
      if (!transactionHash) return { kind: "UNKNOWN", detail: "no transaction hash recorded for this attempt" };
      const resp = await client.getSettleStatus(transactionHash);
      if (!resp.success) {
        return { kind: "FAILED", failureCode: "FACILITATOR_REPORTED_FAILURE", failureDetail: resp.status ?? null };
      }
      if (resp.status === "success") {
        return {
          kind: "CONFIRMED",
          source: "facilitator_settle_status",
          transactionHash,
          paymentId,
          terms,
        };
      }
      return { kind: "PENDING", transactionHash, paymentId };
    },
  };
}
