/**
 * Re-running delivery verification over evidence production already holds.
 *
 *   POST /internal/consumer/intents/:intentId/verify-delivery
 *
 * WHY THIS IS A ROUTE AND NOT A DATABASE SCRIPT
 *
 * The first bounded Purch proof completed with `untchVerified: false, method: NONE`. The settlement is
 * real, the result is persisted, and the only thing missing was a check the adapter had never been
 * taught to make for a paid read.
 *
 * The obvious way to fix that record is an UPDATE. It is also the wrong way twice over: it would need a
 * production database credential in someone's hands, and it would edit a historical claim so that nobody
 * could later tell what was known at settlement from what was established afterwards.
 *
 * So the redrive runs INSIDE production, over production's own store, through the same orchestrator the
 * lifecycle uses — and it appends rather than edits.
 *
 * WHAT IT CANNOT DO
 *
 * Pay. It reaches no adapter method that takes a payment capability, mints no capability, constructs no
 * rail client and loads no signer. `verifyPersistedPaidRead` is a pure function over stored data with no
 * fetch, no key and no RPC in its import graph. A verifier that re-fetched the result would be checking
 * a NEW answer against an OLD payment, which proves nothing about what was bought and would spend money
 * to prove it.
 */

import type { Express, Request, Response } from "express";
import { authenticateOperator } from "../internal-auth";
import type { ConsumerWiring } from "./wiring";
import { classifyFailure } from "./operator-error-classification";
import { operatorEnvironmentOf } from "./operator-routes";
import { SupersedingReceiptConflictError } from "@untch/consumer-core";

export const OPERATOR_VERIFY_DELIVERY_ROUTE = "/internal/consumer/intents/:intentId/verify-delivery" as const;
export const OPERATOR_VERIFY_RECEIPT_ROUTE = "/internal/consumer/intents/:intentId/verification-receipt" as const;

export interface VerifyRoutesDeps {
  readonly wiring: ConsumerWiring | null;
  readonly env?: NodeJS.ProcessEnv;
}

export function registerConsumerVerifyRoutes(app: Express, deps: VerifyRoutesDeps): void {
  const env = deps.env ?? process.env;

  app.post(OPERATOR_VERIFY_DELIVERY_ROUTE, (req: Request, res: Response) => {
    const auth = authenticateOperator(req, { route: OPERATOR_VERIFY_DELIVERY_ROUTE, env });
    if (!auth.ok) {
      res.status(auth.status).json({
        code: auth.code,
        message: auth.message,
        retryable: auth.code === "OPS_AUTH_THROTTLED",
        docsUrl: null,
      });
      return;
    }
    const wiring = deps.wiring;
    if (!wiring) {
      res.status(503).json({
        code: "CONSUMER_PACK_NOT_CONFIGURED",
        message: "no production store is wired on this instance",
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    const intentId = req.params.intentId ?? "";

    (async (): Promise<void> => {
      const { isProduction, environment } = operatorEnvironmentOf(env);

      const { record, alreadyRecorded, intent } = await wiring.orchestrator.redriveDeliveryVerification(intentId);
      const evidence = await wiring.store.getDeliveryEvidence(intentId);
      const base = wiring.publicBaseUrl.replace(/\/+$/, "");

      /**
       * 200 whether the verification PASSED or was refused.
       *
       * A refusal is a successful redrive: the operator asked what production could prove and production
       * answered precisely. A 4xx would make "the request was malformed" indistinguishable from "the
       * evidence does not support the claim", and the second is the answer that matters.
       */
      res.status(200).json({
        intentId,
        verification: {
          verificationId: record.verificationId,
          verifierVersion: record.verifierVersion,
          method: record.method,
          verified: record.verified,
          detail: record.detail,
          evidenceDigest: record.evidenceDigest,
          requestHash: record.requestHash,
          resultHash: record.resultHash,
          quoteHash: record.quoteHash,
          settlementTx: record.settlementTx,
          settledAmount: record.settledAmount,
          settlementChain: record.settlementChain,
          originalReceiptId: record.originalReceiptId,
          supersedingReceiptId: record.supersedingReceiptId,
          refusals: record.refusals,
          verifiedAt: record.verifiedAt,
        },
        /**
         * Whether this call WROTE the record or found it already there.
         *
         * Reported rather than hidden, because an operator re-running a redrive needs to know they are
         * looking at the original verification and not a fresh one that happens to agree.
         */
        alreadyRecorded,
        idempotent: true,
        deliveryProjection:
          evidence === null
            ? null
            : {
                providerAttested: evidence.providerAttested.status,
                untchVerified: evidence.untchVerified.verified,
                method: evidence.untchVerified.method,
                verifiedAt: evidence.untchVerified.verifiedAt,
              },
        intentState: intent.state,
        publicReceiptUrl: `${base}/consumer/receipt/${intentId}`,
        environment,
        productionStore: isProduction,
        operatorKeyId: auth.operatorKeyId,
        paid: false,
        providerCalled: false,
        signerLoaded: false,
        note:
          "Verification read only evidence production already held. No provider request was made, no " +
          "signer was loaded, no transaction was submitted and no proof gate was touched. The original " +
          "receipt keeps its original fields and timestamps; this verification is recorded separately, " +
          "with its own later timestamp, and appears on the public receipt as a subsequent addendum.",
      });
    })().catch((err: unknown) => {
      /**
       * Classified, never handed to express.
       *
       * A refusal here must not alter the existing receipt, and it must be readable — an HTML 500 would
       * leave an operator unable to tell whether anything had been written.
       */
      const classified = classifyFailure(err);
      res.status(classified.status).json({
        code: classified.code,
        message: classified.message,
        intentId,
        stage: "DELIVERY_VERIFICATION",
        disposition: classified.disposition,
        retryable: classified.retryable,
        recordWritten: false,
        receiptAltered: false,
        paid: false,
        docsUrl: null,
      });
    });
  });

  /**
   * Mint the VERIFY receipt that carries the delivery-verification addendum.
   *
   * Separate from anchoring the settlement receipt, and separate from the verification itself. It moves
   * no money, reaches no provider and loads no signer inside the ASP: it writes one durable receipt row
   * whose anchoring the existing worker performs later, on its own schedule.
   */
  app.post(OPERATOR_VERIFY_RECEIPT_ROUTE, (req: Request, res: Response) => {
    const auth = authenticateOperator(req, { route: OPERATOR_VERIFY_RECEIPT_ROUTE, env });
    if (!auth.ok) {
      res.status(auth.status).json({ code: auth.code, message: auth.message, retryable: false, docsUrl: null });
      return;
    }
    const wiring = deps.wiring;
    if (!wiring) {
      res.status(503).json({
        code: "CONSUMER_PACK_NOT_CONFIGURED",
        message: "no production store is wired on this instance",
        retryable: false,
        docsUrl: null,
      });
      return;
    }
    const intentId = req.params.intentId ?? "";

    (async (): Promise<void> => {
      const out = await wiring.orchestrator.createVerificationReceipt(intentId);
      const base = wiring.publicBaseUrl.replace(/\/+$/, "");
      res.status(out.receiptId === null ? 503 : 200).json({
        intentId,
        verificationId: out.verification.verificationId,
        verificationReceiptId: out.receiptId,
        alreadyMinted: out.alreadyMinted,
        reason: out.reason,
        /** What this receipt covers, stated so it can never be read as covering the settlement too. */
        covers: "DELIVERY_VERIFICATION_ADDENDUM",
        relationship: "SUBSEQUENT_TO_SETTLEMENT",
        originalReceiptId: out.verification.originalReceiptId,
        verifierVersion: out.verification.verifierVersion,
        evidenceDigest: out.verification.evidenceDigest,
        resultHash: out.verification.resultHash,
        verifiedAt: out.verification.verifiedAt,
        publicReceiptUrl: `${base}/consumer/receipt/${intentId}`,
        ledgerMovement: false,
        paid: false,
        providerCalled: false,
        signerLoaded: false,
        note:
          "This receipt records the delivery-verification addendum only. Anchoring the settlement " +
          "receipt does not anchor this claim, and anchoring this does not anchor the settlement. The " +
          "public receipt reports the two states separately until both confirm.",
      });
    })().catch((err: unknown) => {
      const classified = classifyFailure(err);
      const conflict = err instanceof SupersedingReceiptConflictError;
      res.status(conflict ? 409 : classified.status).json({
        code: conflict ? "VERIFICATION_RECEIPT_CONFLICT" : classified.code,
        message: conflict ? err.message : classified.message,
        intentId,
        stage: "VERIFICATION_RECEIPT",
        retryable: false,
        receiptAltered: false,
        ledgerMovement: false,
        paid: false,
        docsUrl: null,
      });
    });
  });
}
